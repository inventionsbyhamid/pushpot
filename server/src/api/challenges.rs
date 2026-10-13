use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Duration as TimeDelta, Utc};
use serde::{Deserialize, Serialize};

use super::pots::{PotRow, PotView, select_pots};
use crate::{
    chain::IPushPot::PotParams,
    challenges::{self, CATALOG, Cadence, OpenError, Template, Tier},
    error::{AppError, AppResult},
    http::ClientIp,
    state::AppState,
};

/// Long enough to absorb a busy landing page, short enough that member counts stay fresh.
const CACHE_TTL: Duration = Duration::from_secs(5);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/challenges", get(list))
        .route("/api/challenges/open", post(open))
}

/// The last `/api/challenges` response, shared by every caller for a few seconds.
#[derive(Default)]
pub struct ChallengeCache {
    entry: Mutex<Option<(Instant, Bytes)>>,
}

impl ChallengeCache {
    fn get(&self) -> Option<Bytes> {
        let entry = self.entry.lock().unwrap_or_else(|e| e.into_inner());
        entry
            .as_ref()
            .filter(|(at, _)| at.elapsed() < CACHE_TTL)
            .map(|(_, body)| body.clone())
    }

    fn put(&self, body: Bytes) {
        *self.entry.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), body));
    }

    fn clear(&self) {
        *self.entry.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[derive(sqlx::FromRow)]
struct ChallengeRow {
    #[sqlx(flatten)]
    pot: PotRow,
    template_key: String,
}

#[derive(Serialize)]
struct ListResponse {
    challenges: Vec<ChallengeView>,
}

#[derive(Serialize)]
struct ChallengeView {
    template: TemplateView,
    plan: PlanView,
    /// The pot on chain, or `None` until someone opens the challenge by joining it.
    pot: Option<PotView>,
}

/// A challenge's terms, known from the schedule before it exists on chain.
#[derive(Serialize)]
struct PlanView {
    title: String,
    stake: i64,
    reps_per_period: i32,
    periods: i32,
    period_seconds: i32,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    max_members: i32,
}

impl PlanView {
    fn from_params(params: PotParams) -> Self {
        let start_time = DateTime::from_timestamp(params.startTime as i64, 0).unwrap_or_default();
        Self {
            end_time: start_time
                + TimeDelta::seconds(i64::from(params.periodSeconds) * i64::from(params.periods)),
            title: params.title,
            stake: params.stake as i64,
            reps_per_period: i32::from(params.repsPerPeriod),
            periods: i32::from(params.periods),
            period_seconds: params.periodSeconds as i32,
            start_time,
            max_members: i32::from(params.maxMembers),
        }
    }

    fn from_pot(pot: &PotRow) -> Self {
        let schedule = pot.schedule();
        Self {
            title: pot.title.clone(),
            stake: pot.stake,
            reps_per_period: pot.reps_per_period,
            periods: pot.periods,
            period_seconds: pot.period_seconds,
            start_time: pot.start_time,
            end_time: schedule.end(),
            max_members: pot.max_members,
        }
    }
}

#[derive(Serialize)]
struct TemplateView {
    key: &'static str,
    cadence: Cadence,
    name: &'static str,
    tier: Tier,
    tagline: &'static str,
}

impl From<&'static Template> for TemplateView {
    fn from(template: &'static Template) -> Self {
        Self {
            key: template.key,
            cadence: template.cadence,
            name: template.name,
            tier: template.tier,
            tagline: template.tagline,
        }
    }
}

/// Official challenges that haven't ended, soonest first: everything on offer from the catalog,
/// with its pot once someone has opened it, plus opened ones already under way.
async fn list(State(state): State<AppState>) -> AppResult<Response> {
    if let Some(body) = state.challenge_cache.get() {
        return Ok(json(body));
    }

    let rows: Vec<ChallengeRow> = sqlx::query_as(select_pots!(
        ", c.template_key",
        "join challenges c on c.pot_id = p.id
         where p.official
           and p.start_time + p.periods * p.period_seconds * interval '1 second' > now()
         order by p.start_time, p.id
         limit 100"
    ))
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    let mut challenges: Vec<ChallengeView> = rows
        .into_iter()
        .filter_map(|row| {
            let template = challenges::template(&row.template_key)?;
            Some(ChallengeView {
                template: template.into(),
                plan: PlanView::from_pot(&row.pot),
                pot: Some(PotView::new(row.pot, now)),
            })
        })
        .collect();
    for template in CATALOG {
        for start in template.upcoming(now) {
            let opened = challenges
                .iter()
                .any(|c| c.template.key == template.key && c.plan.start_time == start);
            if !opened {
                challenges.push(ChallengeView {
                    template: template.into(),
                    plan: PlanView::from_params(template.params(start)),
                    pot: None,
                });
            }
        }
    }
    challenges.sort_by(|a, b| {
        (a.plan.start_time, a.template.key).cmp(&(b.plan.start_time, b.template.key))
    });
    let body = Bytes::from(
        serde_json::to_vec(&ListResponse { challenges })
            .map_err(|err| anyhow::anyhow!("encoding challenges: {err}"))?,
    );
    state.challenge_cache.put(body.clone());
    Ok(json(body))
}

#[derive(Deserialize)]
struct OpenRequest {
    key: String,
    start_time: DateTime<Utc>,
}

#[derive(Serialize)]
struct OpenResponse {
    pot_id: u64,
}

/// Puts a challenge on chain the first time someone wants to join it. Anyone may call it: only
/// catalog instances on offer can be opened, and each only once.
async fn open(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<OpenRequest>,
) -> AppResult<Json<OpenResponse>> {
    if !state.auth_limiter.allow(&ip) {
        return Err(AppError::TooManyRequests);
    }
    match challenges::open(&state, &req.key, req.start_time).await {
        Ok(pot_id) => {
            state.challenge_cache.clear();
            Ok(Json(OpenResponse { pot_id }))
        }
        Err(err @ OpenError::NotOffered) => Err(AppError::Unprocessable(err.to_string())),
        Err(err @ (OpenError::NotReady | OpenError::Disabled)) => {
            Err(AppError::Unavailable(err.to_string()))
        }
        Err(OpenError::Unavailable(reason)) => Err(AppError::Upstream(reason)),
        Err(OpenError::Internal(err)) => Err(AppError::Internal(err)),
    }
}

fn json(body: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}
