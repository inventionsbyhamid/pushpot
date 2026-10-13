use alloy::primitives::{Address, B256};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::header,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sqlx::PgPool;
use uuid::Uuid;

use super::pots::find_pot;
use crate::{
    auth::Session,
    chain::{
        indexer::insert_checkin,
        oracle::{CheckInRequest, OracleError},
        redact_url,
    },
    error::{AppError, AppResult},
    pots::Status,
    state::{AppState, PotEvent, PotEventKind},
    telemetry::{self, Rejection, Telemetry},
};

const MAX_TELEMETRY_BYTES: usize = 512 * 1024;
const IN_FLIGHT: &str = "this check in is already being recorded";
const ALREADY_CHECKED_IN: &str = "you've already checked in for this period";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workouts", post(start))
        .route(
            "/api/workouts/{id}/complete",
            post(complete).layer(DefaultBodyLimit::max(MAX_TELEMETRY_BYTES)),
        )
        .route("/api/evidence/{hash}", get(evidence))
}

#[derive(Deserialize)]
struct StartRequest {
    pot_id: i64,
}

#[derive(Serialize)]
struct StartResponse {
    workout_id: Uuid,
    period: i32,
    reps_target: i32,
    period_ends_at: DateTime<Utc>,
}

async fn start(
    State(state): State<AppState>,
    session: Session,
    Json(req): Json<StartRequest>,
) -> AppResult<Json<StartResponse>> {
    if !state.workout_limiter.allow(&session.address) {
        return Err(AppError::TooManyRequests);
    }
    let pot = find_pot(&state, req.pot_id).await?;
    let schedule = pot.schedule();
    let now = Utc::now();
    let period = schedule.current_period(now).ok_or_else(|| {
        AppError::Conflict(match schedule.status(now) {
            Status::Upcoming => "this pot hasn't started yet".into(),
            _ => "this pot has ended".into(),
        })
    })?;

    if !is_member(&state, pot.id, &session.address).await? {
        return Err(AppError::Forbidden("you're not in this pot".into()));
    }

    let checked_in: Vec<i32> =
        sqlx::query_scalar("select period from checkins where pot_id = $1 and address = $2")
            .bind(pot.id)
            .bind(&session.address)
            .fetch_all(&state.db)
            .await?;
    if checked_in.contains(&period) {
        return Err(AppError::Conflict(ALREADY_CHECKED_IN.into()));
    }
    if schedule.progress(&checked_in, now).1 {
        return Err(AppError::Conflict(
            "you missed a period, so you're out of this pot".into(),
        ));
    }

    let workout_id = open_workout(
        &state.db,
        pot.id,
        &session.address,
        period,
        pot.reps_per_period,
    )
    .await?;

    Ok(Json(StartResponse {
        workout_id,
        period,
        reps_target: pot.reps_per_period,
        period_ends_at: schedule.period_end(period),
    }))
}

async fn is_member(state: &AppState, pot_id: i64, address: &str) -> AppResult<bool> {
    let indexed: bool = sqlx::query_scalar(
        "select exists(select 1 from members where pot_id = $1 and address = $2 and active)",
    )
    .bind(pot_id)
    .bind(address)
    .fetch_one(&state.db)
    .await?;
    if indexed {
        return Ok(true);
    }

    // A join from the last few seconds may not be indexed yet; the contract has the final say.
    let account: Address = address
        .parse()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?;
    state
        .chain
        .is_member(pot_id as u64, account)
        .await
        .map_err(|err| {
            let error = redact_url(&err.to_string(), &state.config.rpc_url);
            tracing::warn!(%error, pot_id, "membership lookup failed");
            AppError::Upstream("couldn't reach Arc right now, please retry".into())
        })
}

/// Returns the member's open workout for the period, starting one if there is none.
///
/// A reused workout keeps its original `started_at`. The duration check then still only allows
/// time that really passed since the member first started, while resetting it would reject a
/// session that is still running in another tab.
async fn open_workout(
    db: &PgPool,
    pot_id: i64,
    address: &str,
    period: i32,
    reps_target: i32,
) -> AppResult<Uuid> {
    loop {
        let existing: Option<(Uuid, String)> = sqlx::query_as(
            "select id, status from workouts
             where pot_id = $1 and address = $2 and period = $3
               and status in ('started', 'submitting', 'failed')
             order by status = 'submitting' desc, started_at desc
             limit 1",
        )
        .bind(pot_id)
        .bind(address)
        .bind(period)
        .fetch_optional(db)
        .await?;
        match existing {
            Some((_, status)) if status == "submitting" => {
                return Err(AppError::Conflict(IN_FLIGHT.into()));
            }
            Some((id, _)) => return Ok(id),
            None => {}
        }

        let inserted: Option<Uuid> = sqlx::query_scalar(
            "insert into workouts (id, pot_id, address, period, reps_target, status)
             values ($1, $2, $3, $4, $5, 'started')
             on conflict (pot_id, address, period) where status = 'started' do nothing
             returning id",
        )
        .bind(Uuid::new_v4())
        .bind(pot_id)
        .bind(address)
        .bind(period)
        .bind(reps_target)
        .fetch_optional(db)
        .await?;
        if let Some(id) = inserted {
            return Ok(id);
        }
        // A concurrent start won the insert; go round and pick up its workout.
    }
}

#[derive(Deserialize)]
struct CompleteRequest {
    telemetry: Box<RawValue>,
}

#[derive(Serialize)]
struct CompleteResponse {
    status: &'static str,
    tx_hash: String,
    latency_ms: i32,
}

#[derive(sqlx::FromRow)]
struct WorkoutRow {
    pot_id: i64,
    address: String,
    period: i32,
    reps_target: i32,
    status: String,
    /// Measured by Postgres, which also set `started_at`, so clock skew can't creep in.
    elapsed_ms: f64,
    evidence_hash: Option<String>,
    tx_hash: Option<String>,
    latency_ms: Option<i32>,
    reject_reason: Option<String>,
}

async fn complete(
    State(state): State<AppState>,
    session: Session,
    Path(id): Path<Uuid>,
    Json(req): Json<CompleteRequest>,
) -> AppResult<Json<CompleteResponse>> {
    if !state.workout_limiter.allow(&session.address) {
        return Err(AppError::TooManyRequests);
    }
    let workout: WorkoutRow = sqlx::query_as(
        "select pot_id, address, period, reps_target, status,
                extract(epoch from now() - started_at)::float8 * 1000 as elapsed_ms,
                evidence_hash, tx_hash, latency_ms, reject_reason
         from workouts where id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .filter(|w: &WorkoutRow| w.address == session.address)
    .ok_or(AppError::NotFound)?;

    match workout.status.as_str() {
        "recorded" => return Ok(recorded(workout.tx_hash, workout.latency_ms)),
        "rejected" => {
            return Err(AppError::Unprocessable(
                workout.reject_reason.unwrap_or_default(),
            ));
        }
        "submitting" => return Err(AppError::Conflict(IN_FLIGHT.into())),
        _ => {}
    }

    // Never queue a check-in for a period that already has one.
    let slot = Slot {
        pot_id: workout.pot_id,
        address: &workout.address,
        period: workout.period,
    };
    if let Some(done) =
        settle_checked_in(&state, id, &slot, workout.evidence_hash.as_deref()).await?
    {
        return Ok(done);
    }

    let raw = req.telemetry.get();
    let telemetry: Telemetry = serde_json::from_str(raw)
        .map_err(|e| AppError::BadRequest(format!("invalid telemetry: {e}")))?;

    let pot = find_pot(&state, workout.pot_id).await?;
    let now = Utc::now();
    if !pot.schedule().accepts_check_in(workout.period, now) {
        return reject(&state, id, raw, "this period has closed").await;
    }

    let context = telemetry::Context {
        workout_id: id,
        reps_target: workout.reps_target as u32,
        server_elapsed_ms: workout.elapsed_ms,
    };
    let verdict = match telemetry::validate(&telemetry, &context) {
        Ok(verdict) => verdict,
        Err(rejection) => return reject(&state, id, raw, &rejection.to_string()).await,
    };
    let evidence = telemetry::evidence_hash(raw);

    let claimed = sqlx::query(
        "update workouts set status = 'submitting', telemetry = $2, telemetry_bytes = $3,
                evidence_hash = $4, reps = $5, trace_fingerprint = $6, completed_at = now()
         where id = $1 and status in ('started', 'failed')",
    )
    .bind(id)
    .bind(raw)
    .bind(raw.len() as i32)
    .bind(format!("{evidence:#x}"))
    .bind(verdict.reps as i32)
    .bind(verdict.fingerprint.as_slice())
    .execute(&state.db)
    .await;
    match claimed {
        Ok(result) if result.rows_affected() == 1 => {}
        Ok(_) => return Err(AppError::Conflict(IN_FLIGHT.into())),
        Err(err) => {
            let constraint = err.as_database_error().and_then(|e| e.constraint());
            return match constraint {
                Some("workouts_in_flight_idx") => Err(AppError::Conflict(IN_FLIGHT.into())),
                Some("workouts_trace_fingerprint_idx") => {
                    reject(&state, id, raw, &Rejection::Replayed.to_string()).await
                }
                _ => Err(err.into()),
            };
        }
    }

    let submission = Submission {
        id,
        pot_id: pot.id,
        address: workout.address,
        period: workout.period,
        reps: verdict.reps.min(u32::from(u16::MAX)) as u16,
        evidence,
    };
    // On its own task so a client that disconnects mid-request can't abandon the check-in
    // half-way and leave the workout stuck in 'submitting'.
    tokio::spawn(submit(state, submission))
        .await
        .map_err(|err| AppError::Internal(err.into()))?
}

/// The member and period a workout checks in for.
struct Slot<'a> {
    pot_id: i64,
    address: &'a str,
    period: i32,
}

struct Submission {
    id: Uuid,
    pot_id: i64,
    address: String,
    period: i32,
    reps: u16,
    evidence: B256,
}

/// Sends the check-in and records the outcome.
async fn submit(state: AppState, s: Submission) -> AppResult<Json<CompleteResponse>> {
    let member: Address = s
        .address
        .parse()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?;
    let evidence_hex = format!("{:#x}", s.evidence);
    let request = CheckInRequest {
        pot_id: s.pot_id as u64,
        member,
        period: s.period as u16,
        reps: s.reps,
        evidence: s.evidence,
    };

    match state.oracle.check_in(request).await {
        Ok(receipt) => {
            let tx_hash = format!("{:#x}", receipt.tx_hash);
            let latency_ms = receipt.latency_ms.min(i32::MAX as u64) as i32;
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "update workouts set status = 'recorded', tx_hash = $2, latency_ms = $3 where id = $1",
            )
            .bind(s.id)
            .bind(&tx_hash)
            .bind(latency_ms)
            .execute(&mut *tx)
            .await?;
            let inserted = insert_checkin(
                &mut tx,
                s.pot_id,
                &s.address,
                s.period,
                i32::from(s.reps),
                &evidence_hex,
                &tx_hash,
                receipt.block_number as i64,
            )
            .await?;
            tx.commit().await?;
            if inserted {
                let _ = state.events.send(PotEvent {
                    pot_id: s.pot_id,
                    kind: PotEventKind::CheckedIn,
                    address: s.address,
                    period: Some(s.period),
                    reps: Some(i32::from(s.reps)),
                    tx_hash: tx_hash.clone(),
                });
            }
            Ok(recorded(Some(tx_hash), Some(latency_ms)))
        }
        Err(OracleError::AlreadyCheckedIn) => {
            let slot = Slot {
                pot_id: s.pot_id,
                address: &s.address,
                period: s.period,
            };
            match settle_checked_in(&state, s.id, &slot, Some(&evidence_hex)).await? {
                Some(done) => Ok(done),
                None => {
                    mark(&state, s.id, "rejected", Some(ALREADY_CHECKED_IN)).await?;
                    Err(AppError::Conflict(ALREADY_CHECKED_IN.into()))
                }
            }
        }
        Err(OracleError::Rejected(reason)) => {
            mark(&state, s.id, "rejected", Some(&reason)).await?;
            Err(AppError::Unprocessable(reason))
        }
        Err(OracleError::Unavailable(detail)) => {
            tracing::warn!(workout = %s.id, %detail, "check-in unavailable");
            mark(&state, s.id, "failed", None).await?;
            Err(AppError::Upstream(
                "couldn't reach Arc right now, please retry".into(),
            ))
        }
    }
}

/// Settles a workout whose period already has a check-in on record. It belongs to this workout
/// if the evidence matches (an earlier attempt landed after we stopped waiting for its receipt);
/// otherwise the period is taken. Returns `None` when there is no check-in on record.
async fn settle_checked_in(
    state: &AppState,
    id: Uuid,
    slot: &Slot<'_>,
    evidence: Option<&str>,
) -> AppResult<Option<Json<CompleteResponse>>> {
    let existing: Option<(String, String)> = sqlx::query_as(
        "select tx_hash, evidence_hash from checkins
         where pot_id = $1 and address = $2 and period = $3",
    )
    .bind(slot.pot_id)
    .bind(slot.address)
    .bind(slot.period)
    .fetch_optional(&state.db)
    .await?;
    let Some((tx_hash, hash)) = existing else {
        return Ok(None);
    };
    if evidence == Some(hash.as_str()) {
        sqlx::query("update workouts set status = 'recorded', tx_hash = $2 where id = $1")
            .bind(id)
            .bind(&tx_hash)
            .execute(&state.db)
            .await?;
        return Ok(Some(recorded(Some(tx_hash), None)));
    }
    mark(state, id, "rejected", Some(ALREADY_CHECKED_IN)).await?;
    Err(AppError::Conflict(ALREADY_CHECKED_IN.into()))
}

fn recorded(tx_hash: Option<String>, latency_ms: Option<i32>) -> Json<CompleteResponse> {
    Json(CompleteResponse {
        status: "recorded",
        tx_hash: tx_hash.unwrap_or_default(),
        latency_ms: latency_ms.unwrap_or_default(),
    })
}

/// Rejects the workout, keeping only the hash and size of what was sent so rejected uploads
/// can't fill the disk.
async fn reject(
    state: &AppState,
    id: Uuid,
    raw: &str,
    reason: &str,
) -> AppResult<Json<CompleteResponse>> {
    sqlx::query(
        "update workouts set status = 'rejected', telemetry = null, telemetry_bytes = $2,
                evidence_hash = $3, reject_reason = $4, completed_at = now()
         where id = $1 and status in ('started', 'failed')",
    )
    .bind(id)
    .bind(raw.len() as i32)
    .bind(format!("{:#x}", telemetry::evidence_hash(raw)))
    .bind(reason)
    .execute(&state.db)
    .await?;
    Err(AppError::Unprocessable(reason.to_owned()))
}

async fn mark(state: &AppState, id: Uuid, status: &str, reason: Option<&str>) -> AppResult<()> {
    sqlx::query("update workouts set status = $2, reject_reason = $3 where id = $1")
        .bind(id)
        .bind(status)
        .bind(reason)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Settles workouts left in 'submitting' by a crash or redeploy mid-check-in: 'recorded' if the
/// check-in reached the chain, otherwise 'failed' so the member can submit it again. Two minutes
/// is well past the longest a check-in can take (queue wait plus receipt timeout).
pub async fn sweep_stuck(db: &PgPool) -> sqlx::Result<u64> {
    let mut tx = db.begin().await?;
    let recorded = sqlx::query(
        "update workouts w set status = 'recorded', tx_hash = c.tx_hash
         from checkins c
         where w.status = 'submitting' and w.completed_at < now() - interval '2 minutes'
           and c.pot_id = w.pot_id and c.address = w.address and c.period = w.period
           and c.evidence_hash = w.evidence_hash",
    )
    .execute(&mut *tx)
    .await?;
    let failed = sqlx::query(
        "update workouts set status = 'failed'
         where status = 'submitting' and completed_at < now() - interval '2 minutes'",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(recorded.rows_affected() + failed.rows_affected())
}

async fn evidence(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<impl IntoResponse> {
    let row: Option<(Option<String>, i64)> = sqlx::query_as(
        "select telemetry, pot_id from workouts where evidence_hash = $1 and status = 'recorded'",
    )
    .bind(hash.to_lowercase())
    .fetch_optional(&state.db)
    .await?;
    let Some((Some(telemetry), pot_id)) = row else {
        return Err(AppError::NotFound);
    };
    // Published only once check-ins have closed, so a live trace can't be copied mid-challenge.
    let pot = find_pot(&state, pot_id).await?;
    if !pot.schedule().check_ins_closed(Utc::now()) {
        return Err(AppError::NotFound);
    }
    Ok(([(header::CONTENT_TYPE, "application/json")], telemetry))
}
