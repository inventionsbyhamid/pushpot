use std::{collections::HashMap, convert::Infallible, time::Duration};

use axum::{
    Json, Router,
    extract::{Path, State},
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
};
use chrono::{DateTime, Utc};
use futures_util::{Stream, StreamExt};
use serde::Serialize;
use tokio_stream::wrappers::BroadcastStream;

use crate::{
    auth::Session,
    error::{AppError, AppResult},
    pots::{Schedule, Status},
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/pots", get(list))
        .route("/api/pots/{id}", get(detail))
        .route("/api/pots/{id}/events", get(events))
}

#[derive(sqlx::FromRow)]
pub struct PotRow {
    pub id: i64,
    pub title: String,
    pub creator: String,
    pub stake: i64,
    pub reps_per_period: i32,
    pub periods: i32,
    pub period_seconds: i32,
    pub start_time: DateTime<Utc>,
    pub max_members: i32,
    pub member_count: i64,
}

impl PotRow {
    pub fn schedule(&self) -> Schedule {
        Schedule {
            start: self.start_time,
            period_seconds: i64::from(self.period_seconds),
            periods: self.periods,
        }
    }
}

macro_rules! select_pots {
    ($rest:literal) => {
        concat!(
            "select p.id, p.title, p.creator, p.stake, p.reps_per_period, p.periods,
                    p.period_seconds, p.start_time, p.max_members,
                    (select count(*) from members m where m.pot_id = p.id and m.active) as member_count
             from pots p ",
            $rest
        )
    };
}

#[derive(Serialize)]
pub struct PotView {
    id: i64,
    title: String,
    creator: String,
    stake: i64,
    reps_per_period: i32,
    periods: i32,
    period_seconds: i32,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    max_members: i32,
    member_count: i64,
    status: Status,
    current_period: Option<i32>,
}

impl PotView {
    fn new(row: PotRow, now: DateTime<Utc>) -> Self {
        let schedule = row.schedule();
        Self {
            id: row.id,
            title: row.title,
            creator: row.creator,
            stake: row.stake,
            reps_per_period: row.reps_per_period,
            periods: row.periods,
            period_seconds: row.period_seconds,
            start_time: row.start_time,
            end_time: schedule.end(),
            max_members: row.max_members,
            member_count: row.member_count,
            status: schedule.status(now),
            current_period: schedule.current_period(now),
        }
    }
}

pub async fn find_pot(state: &AppState, id: i64) -> AppResult<PotRow> {
    sqlx::query_as::<_, PotRow>(select_pots!("where p.id = $1"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or(AppError::NotFound)
}

#[derive(Serialize)]
struct ListResponse {
    pots: Vec<PotView>,
}

/// The caller's own pots. Pots are invite-only, so there is no public listing.
async fn list(State(state): State<AppState>, session: Session) -> AppResult<Json<ListResponse>> {
    let rows = sqlx::query_as::<_, PotRow>(select_pots!(
        "join members me on me.pot_id = p.id and me.address = $1 and me.active
         order by p.start_time desc limit 100"
    ))
    .bind(&session.address)
    .fetch_all(&state.db)
    .await?;

    let now = Utc::now();
    let pots = rows.into_iter().map(|row| PotView::new(row, now)).collect();
    Ok(Json(ListResponse { pots }))
}

#[derive(Serialize)]
struct MemberView {
    address: String,
    checked_in: Vec<i32>,
    completed: bool,
    out: bool,
    claimed_amount: Option<i64>,
}

#[derive(Serialize)]
struct DetailResponse {
    pot: PotView,
    members: Vec<MemberView>,
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    address: String,
    claimed_amount: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct CheckinRow {
    address: String,
    period: i32,
}

async fn detail(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<DetailResponse>> {
    let row = find_pot(&state, id).await?;
    let members: Vec<MemberRow> = sqlx::query_as(
        "select address, claimed_amount from members where pot_id = $1 and active order by address",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let checkins: Vec<CheckinRow> =
        sqlx::query_as("select address, period from checkins where pot_id = $1 order by period")
            .bind(id)
            .fetch_all(&state.db)
            .await?;

    let mut by_member: HashMap<String, Vec<i32>> = HashMap::new();
    for c in checkins {
        by_member.entry(c.address).or_default().push(c.period);
    }

    let now = Utc::now();
    let schedule = row.schedule();
    let members = members
        .into_iter()
        .map(|m| {
            let checked_in = by_member.remove(&m.address).unwrap_or_default();
            let (completed, out) = schedule.progress(&checked_in, now);
            MemberView {
                address: m.address,
                checked_in,
                completed,
                out,
                claimed_amount: m.claimed_amount,
            }
        })
        .collect();

    Ok(Json(DetailResponse {
        pot: PotView::new(row, now),
        members,
    }))
}

async fn events(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    find_pot(&state, id).await?;
    let permit = state
        .event_streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::Unavailable("too many live connections, try again soon".into()))?;
    let stream = BroadcastStream::new(state.events.subscribe()).filter_map(move |event| {
        // The stream owns the permit, so the slot frees up when the client disconnects.
        let _permit = &permit;
        async move {
            let event = event.ok().filter(|e| e.pot_id == id)?;
            Event::default()
                .event(event.kind.as_str())
                .json_data(&event)
                .ok()
                .map(Ok)
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
