use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::{HeaderMap, HeaderValue, Method, header, request::Parts},
    middleware::Next,
    response::{IntoResponse, Response},
};
use tower_http::services::{ServeDir, ServeFile};

use crate::{error::AppError, state::AppState};

const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' 'wasm-unsafe-eval'; ",
    "style-src 'self' 'unsafe-inline'; ",
    "img-src 'self' data: blob: https:; ",
    "font-src 'self' data:; ",
    "connect-src 'self' https://rpc.mainnet.arc.io https://rpc.testnet.arc.io ",
    "https://*.walletconnect.com wss://*.walletconnect.com ",
    "https://*.walletconnect.org wss://*.walletconnect.org https://*.web3modal.org; ",
    "frame-src https://verify.walletconnect.com https://verify.walletconnect.org; ",
    "worker-src 'self' blob:; ",
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
);

pub async fn security_headers(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    let set = |headers: &mut HeaderMap, name: &'static str, value: &'static str| {
        headers.insert(name, HeaderValue::from_static(value));
    };
    set(headers, "content-security-policy", CONTENT_SECURITY_POLICY);
    set(headers, "x-content-type-options", "nosniff");
    set(
        headers,
        "referrer-policy",
        "strict-origin-when-cross-origin",
    );
    set(
        headers,
        "permissions-policy",
        "camera=(self), microphone=(), geolocation=(), payment=()",
    );
    set(
        headers,
        "cross-origin-opener-policy",
        "same-origin-allow-popups",
    );
    if state.config.is_https() {
        set(
            headers,
            "strict-transport-security",
            "max-age=31536000; includeSubDomains",
        );
    }
    res
}

/// Rejects state-changing API requests that don't come from our own origin (CSRF defence on top
/// of SameSite cookies and JSON-only bodies).
pub async fn require_same_origin(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && req.uri().path().starts_with("/api/") {
        let origin = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok());
        if origin != Some(state.config.origin().as_str()) {
            return AppError::Forbidden("cross origin request blocked".into()).into_response();
        }
    }
    next.run(req).await
}

/// The client address: the last `X-Forwarded-For` hop (appended by our reverse proxy), or the
/// peer address when running without one.
pub struct ClientIp(pub String);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let forwarded = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next())
            .map(|ip| ip.trim().to_owned());
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip().to_string());
        Ok(Self(forwarded.or(peer).unwrap_or_default()))
    }
}

/// Fixed-window rate limiter keyed by an arbitrary string, such as a client IP or an address.
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    hits: Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            hits: Mutex::default(),
        }
    }

    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            hits.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = hits.entry(key.to_owned()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.limit
    }
}

/// Serves the built SPA: hashed assets are cached forever, `index.html` is always revalidated,
/// and unknown paths fall back to the app shell for client-side routing.
pub fn static_files<S>(router: Router<S>, web_dir: &std::path::Path) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let index = web_dir.join("index.html");
    let files = ServeDir::new(web_dir)
        .precompressed_br()
        .precompressed_gzip()
        .fallback(ServeFile::new(index));
    router
        .fallback_service(files)
        .layer(axum::middleware::map_response(cache_control))
}

async fn cache_control(req_path: axum::extract::OriginalUri, mut res: Response) -> Response {
    let path = req_path.path();
    let value = if path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else if path.starts_with("/mediapipe/") {
        "public, max-age=86400"
    } else if path.starts_with("/api/") {
        "no-store"
    } else {
        "no-cache"
    };
    res.headers_mut()
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static(value));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limiter_blocks_after_limit_and_resets() {
        let limiter = RateLimiter::new(2, Duration::from_millis(50));
        assert!(limiter.allow("a"));
        assert!(limiter.allow("a"));
        assert!(!limiter.allow("a"));
        assert!(limiter.allow("b"));
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.allow("a"));
    }
}
