use alloy::primitives::Address;
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
use uuid::Uuid;

use super::pots::find_pot;
use crate::{
    auth::Session,
    chain::{
        indexer::insert_checkin,
        oracle::{CheckInRequest, OracleError},
    },
    error::{AppError, AppResult},
    pots::Status,
    state::{AppState, PotEvent, PotEventKind},
    telemetry::{self, Telemetry},
};

const MAX_TELEMETRY_BYTES: usize = 512 * 1024;

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
    let pot = find_pot(&state, req.pot_id).await?;
    let schedule = pot.schedule();
    let now = Utc::now();
    let period = schedule.current_period(now).ok_or_else(|| {
        AppError::Conflict(match schedule.status(now) {
            Status::Upcoming => "this pot hasn't started yet".into(),
            _ => "this pot has ended".into(),
        })
    })?;

    let is_member: bool = sqlx::query_scalar(
        "select exists(select 1 from members where pot_id = $1 and address = $2 and active)",
    )
    .bind(pot.id)
    .bind(&session.address)
    .fetch_one(&state.db)
    .await?;
    if !is_member {
        return Err(AppError::Forbidden("you're not in this pot".into()));
    }

    let checked_in: Vec<i32> =
        sqlx::query_scalar("select period from checkins where pot_id = $1 and address = $2")
            .bind(pot.id)
            .bind(&session.address)
            .fetch_all(&state.db)
            .await?;
    if checked_in.contains(&period) {
        return Err(AppError::Conflict(
            "you've already checked in for this period".into(),
        ));
    }
    if schedule.progress(&checked_in, now).1 {
        return Err(AppError::Conflict(
            "you missed a period, so you're out of this pot".into(),
        ));
    }

    let workout_id = Uuid::new_v4();
    sqlx::query(
        "insert into workouts (id, pot_id, address, period, reps_target, status)
         values ($1, $2, $3, $4, $5, 'started')",
    )
    .bind(workout_id)
    .bind(pot.id)
    .bind(&session.address)
    .bind(period)
    .bind(pot.reps_per_period)
    .execute(&state.db)
    .await?;

    Ok(Json(StartResponse {
        workout_id,
        period,
        reps_target: pot.reps_per_period,
        period_ends_at: schedule.period_end(period),
    }))
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
    started_at: DateTime<Utc>,
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
    let workout: WorkoutRow = sqlx::query_as(
        "select pot_id, address, period, reps_target, status, started_at, tx_hash, latency_ms,
                reject_reason
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
        "submitting" => {
            return Err(AppError::Conflict(
                "this workout is already being recorded".into(),
            ));
        }
        _ => {}
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
        server_elapsed_ms: (now - workout.started_at).num_milliseconds() as f64,
    };
    let verdict = match telemetry::validate(&telemetry, &context) {
        Ok(verdict) => verdict,
        Err(rejection) => return reject(&state, id, raw, &rejection.to_string()).await,
    };
    let evidence = telemetry::evidence_hash(raw);
    let evidence_hex = format!("{evidence:#x}");

    let claimed = sqlx::query(
        "update workouts set status = 'submitting', telemetry = $2, evidence_hash = $3, reps = $4,
                completed_at = now()
         where id = $1 and status in ('started', 'failed')",
    )
    .bind(id)
    .bind(raw)
    .bind(&evidence_hex)
    .bind(verdict.reps as i32)
    .execute(&state.db)
    .await?;
    if claimed.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "this workout is already being recorded".into(),
        ));
    }

    let member: Address = workout
        .address
        .parse()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("{e}")))?;
    let reps = verdict.reps.min(u32::from(u16::MAX)) as u16;
    let request = CheckInRequest {
        pot_id: pot.id as u64,
        member,
        period: workout.period as u16,
        reps,
        evidence,
    };

    match state.oracle.check_in(request).await {
        Ok(receipt) => {
            let tx_hash = format!("{:#x}", receipt.tx_hash);
            let latency_ms = receipt.latency_ms.min(i32::MAX as u64) as i32;
            let mut tx = state.db.begin().await?;
            sqlx::query(
                "update workouts set status = 'recorded', tx_hash = $2, latency_ms = $3 where id = $1",
            )
            .bind(id)
            .bind(&tx_hash)
            .bind(latency_ms)
            .execute(&mut *tx)
            .await?;
            let inserted = insert_checkin(
                &mut tx,
                pot.id,
                &workout.address,
                workout.period,
                i32::from(reps),
                &evidence_hex,
                &tx_hash,
                receipt.block_number as i64,
            )
            .await?;
            tx.commit().await?;
            if inserted {
                let _ = state.events.send(PotEvent {
                    pot_id: pot.id,
                    kind: PotEventKind::CheckedIn,
                    address: workout.address,
                    period: Some(workout.period),
                    reps: Some(i32::from(reps)),
                    tx_hash: tx_hash.clone(),
                });
            }
            Ok(recorded(Some(tx_hash), Some(latency_ms)))
        }
        Err(OracleError::AlreadyCheckedIn) => {
            // An earlier attempt may have landed after we gave up waiting for its receipt.
            let existing: Option<(String, String)> = sqlx::query_as(
                "select tx_hash, evidence_hash from checkins
                 where pot_id = $1 and address = $2 and period = $3",
            )
            .bind(pot.id)
            .bind(&workout.address)
            .bind(workout.period)
            .fetch_optional(&state.db)
            .await?;
            match existing {
                Some((tx_hash, hash)) if hash == evidence_hex => {
                    sqlx::query(
                        "update workouts set status = 'recorded', tx_hash = $2 where id = $1",
                    )
                    .bind(id)
                    .bind(&tx_hash)
                    .execute(&state.db)
                    .await?;
                    Ok(recorded(Some(tx_hash), None))
                }
                _ => {
                    mark(
                        &state,
                        id,
                        "rejected",
                        Some("already checked in for this period"),
                    )
                    .await?;
                    Err(AppError::Conflict(
                        "you've already checked in for this period".into(),
                    ))
                }
            }
        }
        Err(OracleError::Rejected(reason)) => {
            mark(&state, id, "rejected", Some(&reason)).await?;
            Err(AppError::Unprocessable(reason))
        }
        Err(OracleError::Unavailable(detail)) => {
            tracing::warn!(workout = %id, %detail, "check-in unavailable");
            mark(&state, id, "failed", None).await?;
            Err(AppError::Upstream(
                "couldn't reach Arc right now, please retry".into(),
            ))
        }
    }
}

fn recorded(tx_hash: Option<String>, latency_ms: Option<i32>) -> Json<CompleteResponse> {
    Json(CompleteResponse {
        status: "recorded",
        tx_hash: tx_hash.unwrap_or_default(),
        latency_ms: latency_ms.unwrap_or_default(),
    })
}

async fn reject(
    state: &AppState,
    id: Uuid,
    raw: &str,
    reason: &str,
) -> AppResult<Json<CompleteResponse>> {
    sqlx::query(
        "update workouts set status = 'rejected', telemetry = $2, reject_reason = $3, completed_at = now()
         where id = $1 and status in ('started', 'failed')",
    )
    .bind(id)
    .bind(raw)
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

async fn evidence(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> AppResult<impl IntoResponse> {
    let telemetry: Option<String> = sqlx::query_scalar(
        "select telemetry from workouts where evidence_hash = $1 and status = 'recorded'",
    )
    .bind(hash.to_lowercase())
    .fetch_optional(&state.db)
    .await?;
    let telemetry = telemetry.ok_or(AppError::NotFound)?;
    Ok(([(header::CONTENT_TYPE, "application/json")], telemetry))
}
