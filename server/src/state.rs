use std::sync::Arc;

use serde::Serialize;
use sqlx::PgPool;
use tokio::sync::{Semaphore, broadcast};

use crate::{
    api::challenges::ChallengeCache, chain::Chain, chain::oracle::OracleSender, config::Config,
    http::RateLimiter,
};

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Arc<Config>,
    pub chain: Chain,
    pub oracle: Arc<dyn OracleSender>,
    pub events: broadcast::Sender<PotEvent>,
    /// Keyed by client IP.
    pub auth_limiter: Arc<RateLimiter>,
    /// Keyed by the signed-in address.
    pub workout_limiter: Arc<RateLimiter>,
    /// One permit per open event stream.
    pub event_streams: Arc<Semaphore>,
    pub challenge_cache: Arc<ChallengeCache>,
    /// The built `index.html`, used to render link previews. `None` when the web app isn't built.
    pub index_html: Option<Arc<str>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PotEventKind {
    Joined,
    Left,
    CheckedIn,
    Claimed,
}

impl PotEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Joined => "joined",
            Self::Left => "left",
            Self::CheckedIn => "checked_in",
            Self::Claimed => "claimed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct PotEvent {
    pub pot_id: i64,
    pub kind: PotEventKind,
    pub address: String,
    pub period: Option<i32>,
    pub reps: Option<i32>,
    pub tx_hash: String,
}
