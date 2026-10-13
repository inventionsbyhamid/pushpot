mod api;
mod auth;
mod chain;
mod config;
mod error;
mod http;
mod pots;
mod state;
mod telemetry;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::Context;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{net::TcpListener, signal, sync::broadcast};
use tracing_subscriber::EnvFilter;

use crate::{
    chain::{Chain, oracle::Oracle},
    config::Config,
    http::RateLimiter,
    state::AppState,
};

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
    };

    tokio::spawn(chain::indexer::run(state.clone()));
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
