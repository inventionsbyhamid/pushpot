use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::header,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::Utc;
use serde::Serialize;

use super::pots::{PotRow, PotView, select_pots};
use crate::{
    challenges::{Cadence, Template, Tier},
    error::AppResult,
    state::AppState,
};

/// Long enough to absorb a busy landing page, short enough that member counts stay fresh.
const CACHE_TTL: Duration = Duration::from_secs(5);

pub fn router() -> Router<AppState> {
    Router::new().route("/api/challenges", get(list))
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
    pot: PotView,
    template: TemplateView,
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

/// Official challenges that haven't ended, soonest first.
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
    let challenges = rows
        .into_iter()
        .filter_map(|row| {
            let template = crate::challenges::template(&row.template_key)?;
            Some(ChallengeView {
                pot: PotView::new(row.pot, now),
                template: template.into(),
            })
        })
        .collect();
    let body = Bytes::from(
        serde_json::to_vec(&ListResponse { challenges })
            .map_err(|err| anyhow::anyhow!("encoding challenges: {err}"))?,
    );
    state.challenge_cache.put(body.clone());
    Ok(json(body))
}

fn json(body: Bytes) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}
