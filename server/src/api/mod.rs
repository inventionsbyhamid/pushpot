pub mod pots;
mod workouts;

use axum::{
    Router,
    extract::DefaultBodyLimit,
    middleware::from_fn_with_state,
    routing::{any, get},
};
use tower_http::trace::TraceLayer;

use crate::{
    auth,
    error::AppError,
    http::{require_same_origin, security_headers, static_files},
    state::AppState,
};

pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(auth::router())
        .merge(pots::router())
        .merge(workouts::router())
        .route("/api/{*rest}", any(|| async { AppError::NotFound }))
        .layer(DefaultBodyLimit::max(64 * 1024));

    static_files(api, &state.config.web_dir)
        .layer(from_fn_with_state(state.clone(), require_same_origin))
        .layer(from_fn_with_state(state.clone(), security_headers))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[cfg(test)]
mod tests;
