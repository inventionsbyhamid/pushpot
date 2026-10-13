mod session;
pub mod siwe;

use alloy::{hex, primitives::Address};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use axum_extra::extract::CookieJar;
use chrono::Utc;
use rand::{RngExt, distr::Alphanumeric};
use serde::{Deserialize, Serialize};

pub use session::Session;

use crate::{
    error::{AppError, AppResult},
    http::ClientIp,
    state::AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/nonce", get(nonce))
        .route("/api/auth/verify", post(verify))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(me))
}

#[derive(Serialize)]
struct NonceResponse {
    nonce: String,
}

async fn nonce(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
) -> AppResult<Json<NonceResponse>> {
    if !state.auth_limiter.allow(&ip) {
        return Err(AppError::TooManyRequests);
    }
    let nonce: String = rand::rng()
        .sample_iter(Alphanumeric)
        .take(24)
        .map(char::from)
        .collect();
    sqlx::query("insert into auth_nonces (nonce) values ($1)")
        .bind(&nonce)
        .execute(&state.db)
        .await?;
    Ok(Json(NonceResponse { nonce }))
}

#[derive(Deserialize)]
struct VerifyRequest {
    message: String,
    signature: String,
}

#[derive(Serialize)]
struct MeResponse {
    address: String,
}

async fn verify(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    jar: CookieJar,
    Json(req): Json<VerifyRequest>,
) -> AppResult<(CookieJar, Json<MeResponse>)> {
    if !state.auth_limiter.allow(&ip) {
        return Err(AppError::TooManyRequests);
    }
    if req.message.len() > 4096 {
        return Err(AppError::BadRequest("sign in message is too long".into()));
    }

    let message =
        siwe::Message::parse(&req.message).map_err(|e| AppError::BadRequest(e.to_string()))?;
    let domain = state.config.siwe_domain();
    let origin = state.config.origin();
    message
        .validate(&siwe::Expectations {
            domain: &domain,
            origin: &origin,
            chain_id: state.config.chain_id,
            now: Utc::now(),
        })
        .map_err(|e| AppError::Unprocessable(e.to_string()))?;

    let consumed = sqlx::query(
        "delete from auth_nonces where nonce = $1 and created_at > now() - interval '10 minutes'",
    )
    .bind(&message.nonce)
    .execute(&state.db)
    .await?;
    if consumed.rows_affected() != 1 {
        return Err(AppError::Unprocessable(
            "sign in request expired, please try again".into(),
        ));
    }

    let signature = hex::decode(req.signature.trim())
        .map_err(|_| AppError::BadRequest("bad signature".into()))?;
    if !signature_matches(&state, message.address, &req.message, &signature).await {
        return Err(AppError::Unprocessable(
            "signature doesn't match the address".into(),
        ));
    }

    let address = format_address(message.address);
    let jar = session::create(&state, jar, &address).await?;
    Ok((jar, Json(MeResponse { address })))
}

async fn signature_matches(
    state: &AppState,
    address: Address,
    message: &str,
    signature: &[u8],
) -> bool {
    if siwe::recover_signer(message, signature) == Some(address) {
        return true;
    }
    state
        .chain
        .is_valid_contract_signature(address, message, signature)
        .await
}

async fn logout(
    State(state): State<AppState>,
    jar: CookieJar,
) -> AppResult<(CookieJar, StatusCode)> {
    let jar = session::destroy(&state, jar).await?;
    Ok((jar, StatusCode::NO_CONTENT))
}

async fn me(session: Session) -> Json<MeResponse> {
    Json(MeResponse {
        address: session.address,
    })
}

/// Addresses are stored and returned lowercase so they compare as plain strings.
pub fn format_address(address: Address) -> String {
    format!("{address:#x}")
}
