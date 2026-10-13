use alloy::hex;
use axum::{
    extract::{FromRequestParts, OptionalFromRequestParts},
    http::request::Parts,
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use chrono::{Duration, Utc};
use sha2::{Digest, Sha256};

use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

const TTL: Duration = Duration::days(7);

/// An authenticated wallet, resolved from the session cookie.
pub struct Session {
    pub address: String,
}

fn cookie_name(state: &AppState) -> &'static str {
    // The __Host- prefix makes browsers refuse the cookie unless it is Secure, host-only and
    // path=/, which rules out it being set or shadowed from a sibling subdomain.
    if state.config.is_https() {
        "__Host-pushpot_session"
    } else {
        "pushpot_session"
    }
}

fn hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn create(state: &AppState, jar: CookieJar, address: &str) -> AppResult<CookieJar> {
    let token = hex::encode(rand::random::<[u8; 32]>());
    sqlx::query("insert into sessions (token_hash, address, expires_at) values ($1, $2, $3)")
        .bind(hash(&token))
        .bind(address)
        .bind(Utc::now() + TTL)
        .execute(&state.db)
        .await?;

    let cookie = Cookie::build((cookie_name(state), token))
        .path("/")
        .http_only(true)
        .secure(state.config.is_https())
        .same_site(SameSite::Lax)
        .max_age(time_duration(TTL))
        .build();
    Ok(jar.add(cookie))
}

pub async fn destroy(state: &AppState, jar: CookieJar) -> AppResult<CookieJar> {
    let name = cookie_name(state);
    if let Some(cookie) = jar.get(name) {
        sqlx::query("delete from sessions where token_hash = $1")
            .bind(hash(cookie.value()))
            .execute(&state.db)
            .await?;
    }
    Ok(jar.remove(Cookie::build(name).path("/")))
}

impl FromRequestParts<AppState> for Session {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let token = jar.get(cookie_name(state)).ok_or(AppError::Unauthorized)?;
        let address: Option<String> = sqlx::query_scalar(
            "select address from sessions where token_hash = $1 and expires_at > now()",
        )
        .bind(hash(token.value()))
        .fetch_optional(&state.db)
        .await?;
        address
            .map(|address| Session { address })
            .ok_or(AppError::Unauthorized)
    }
}

impl OptionalFromRequestParts<AppState> for Session {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Option<Self>, Self::Rejection> {
        match <Self as FromRequestParts<AppState>>::from_request_parts(parts, state).await {
            Ok(session) => Ok(Some(session)),
            Err(AppError::Unauthorized) => Ok(None),
            Err(err) => Err(err),
        }
    }
}

fn time_duration(d: Duration) -> time::Duration {
    time::Duration::seconds(d.num_seconds())
}
