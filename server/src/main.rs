mod api;
mod auth;
mod chain;
mod challenges;
mod config;
mod error;
mod fees;
mod http;
mod pots;
mod share;
mod state;
mod telemetry;
#[cfg(test)]
mod testing;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::Context;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{
    net::TcpListener,
    signal,
    sync::{Semaphore, broadcast},
};
use tracing_subscriber::EnvFilter;

use crate::{
    api::challenges::ChallengeCache,
    chain::{Chain, oracle::Oracle},
    config::Config,
    http::RateLimiter,
    state::AppState,
};

const MAX_EVENT_STREAMS: usize = 2_000;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Arc::new(Config::from_env()?);
    let db = PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&config.database_url)
        .await
        .context("connecting to Postgres")?;
    sqlx::migrate!()
        .run(&db)
        .await
        .context("running migrations")?;

    let chain = Chain::connect(&config).await?;
    tracing::info!(
        chain_id = chain.chain_id,
        contract = %chain.contract,
        oracle = %config.oracle_signer.address(),
        "connected to Arc"
    );

    let (events, _) = broadcast::channel(256);
    let state = AppState {
        db: db.clone(),
        config: config.clone(),
        chain,
        oracle: Arc::new(Oracle::spawn(&config)),
        events,
        auth_limiter: Arc::new(RateLimiter::new(30, Duration::from_secs(60))),
        workout_limiter: Arc::new(RateLimiter::new(20, Duration::from_secs(60))),
        event_streams: Arc::new(Semaphore::new(MAX_EVENT_STREAMS)),
        challenge_cache: Arc::new(ChallengeCache::default()),
        index_html: std::fs::read_to_string(config.web_dir.join("index.html"))
            .ok()
            .map(Into::into),
    };

    tokio::spawn(chain::indexer::run(state.clone()));
    if config.curator_enabled {
        tokio::spawn(challenges::run(state.clone()));
    } else {
        tracing::info!("curator disabled: not opening official challenges");
    }
    if config.fee_collector_enabled {
        tokio::spawn(fees::run(state.clone()));
    } else {
        tracing::info!("fee collector disabled");
    }
    tokio::spawn(sweep_stuck_workouts(db.clone()));
    tokio::spawn(prune_expired(db));

    let listener = TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "listening");
    axum::serve(
        listener,
        api::app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

async fn prune_expired(db: PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(600));
    loop {
        interval.tick().await;
        let nonces =
            sqlx::query("delete from auth_nonces where created_at < now() - interval '10 minutes'")
                .execute(&db)
                .await;
        let sessions = sqlx::query("delete from sessions where expires_at < now()")
            .execute(&db)
            .await;
        if let Err(err) = nonces.and(sessions) {
            tracing::warn!(error = %err, "pruning expired auth rows failed");
        }
    }
}

async fn sweep_stuck_workouts(db: PgPool) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        interval.tick().await;
        match api::workouts::sweep_stuck(&db).await {
            Ok(0) => {}
            Ok(swept) => tracing::warn!(swept, "settled workouts stuck mid-check-in"),
            Err(err) => tracing::warn!(error = %err, "sweeping stuck workouts failed"),
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
