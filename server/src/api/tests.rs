use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use alloy::{
    hex,
    primitives::{Address, B256},
    providers::{Provider, ProviderBuilder},
    signers::{SignerSync, local::PrivateKeySigner},
};
use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::sync::broadcast;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    chain::{
        Chain,
        oracle::{CheckInFuture, CheckInReceipt, CheckInRequest, CheckInSender, OracleError},
    },
    config::Config,
    http::RateLimiter,
    state::AppState,
    telemetry::{evidence_hash, fixtures},
};

const ORIGIN: &str = "https://pushpot.test";
const COOKIE: &str = "__Host-pushpot_session";
const ALICE: &str = "0x00000000000000000000000000000000000a11ce";
const BOB: &str = "0x0000000000000000000000000000000000000b0b";

#[derive(Default)]
struct FakeOracle {
    calls: AtomicUsize,
}

impl CheckInSender for FakeOracle {
    fn check_in(&self, _: CheckInRequest) -> CheckInFuture<'_> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok::<_, OracleError>(CheckInReceipt {
                tx_hash: B256::repeat_byte(0xab),
                block_number: 7,
                latency_ms: 640,
            })
        })
    }
}

fn app(db: PgPool, oracle: Arc<FakeOracle>) -> Router {
    let config = Config {
        bind_addr: "127.0.0.1:0".parse().unwrap(),
        database_url: String::new(),
        public_origin: ORIGIN.parse().unwrap(),
        rpc_url: "http://127.0.0.1:9".parse().unwrap(),
        chain_id: 5042,
        contract: Address::ZERO,
        deploy_block: 0,
        oracle_signer: PrivateKeySigner::random(),
        web_dir: "/nonexistent".into(),
        indexer_interval: Duration::from_secs(1),
    };
    let chain = Chain {
        provider: ProviderBuilder::new()
            .connect_http(config.rpc_url.clone())
            .erased(),
        contract: Address::ZERO,
        chain_id: 5042,
        deploy_block: 0,
    };
    crate::api::app(AppState {
        db,
        config: Arc::new(config),
        chain,
        oracle,
        events: broadcast::channel(16).0,
        auth_limiter: Arc::new(RateLimiter::new(100, Duration::from_secs(60))),
        index_html: None,
    })
}

/// A sprint pot (3 × 10 minute periods, 10 reps) that started a minute ago.
async fn seed_pot(db: &PgPool, id: i64, members: &[&str]) {
    sqlx::query(
        "insert into pots (id, creator, title, stake, reps_per_period, periods, period_seconds,
             start_time, max_members, created_tx, created_block)
         values ($1, $2, 'Morning sprint', 10000000, 10, 3, 600, now() - interval '1 minute', 10, '0x', 1)",
    )
    .bind(id)
    .bind(members[0])
    .execute(db)
    .await
    .unwrap();
    for member in members {
        sqlx::query(
            "insert into members (pot_id, address, active, joined_tx) values ($1, $2, true, '0x')",
        )
        .bind(id)
        .bind(member)
        .execute(db)
        .await
        .unwrap();
    }
}

async fn login(db: &PgPool, address: &str) -> String {
    let token = format!("token-{address}");
    sqlx::query("insert into sessions (token_hash, address, expires_at) values ($1, $2, now() + interval '1 day')")
        .bind(Sha256::digest(token.as_bytes()).to_vec())
        .bind(address)
        .execute(db)
        .await
        .unwrap();
    format!("{COOKIE}={token}")
}

struct Call<'a> {
    method: Method,
    uri: &'a str,
    cookie: Option<&'a str>,
    body: Option<String>,
    origin: Option<&'a str>,
}

impl<'a> Call<'a> {
    fn get(uri: &'a str) -> Self {
        Self {
            method: Method::GET,
            uri,
            cookie: None,
            body: None,
            origin: Some(ORIGIN),
        }
    }

    fn post(uri: &'a str, body: impl Into<String>) -> Self {
        Self {
            method: Method::POST,
            body: Some(body.into()),
            ..Self::get(uri)
        }
    }

    fn cookie(mut self, cookie: &'a str) -> Self {
        self.cookie = Some(cookie);
        self
    }

    async fn send(self, app: &Router) -> (StatusCode, Value, Option<String>) {
        let mut req = Request::builder().method(self.method).uri(self.uri);
        if let Some(origin) = self.origin {
            req = req.header(header::ORIGIN, origin);
        }
        if let Some(cookie) = self.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        let req = match self.body {
            Some(body) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body)),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let set_cookie = res
            .headers()
            .get(header::SET_COOKIE)
            .map(|v| v.to_str().unwrap().to_owned());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            set_cookie,
        )
    }
}

async fn start_workout(app: &Router, db: &PgPool, cookie: &str) -> Uuid {
    let (status, body, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(cookie)
        .send(app)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id: Uuid = body["workout_id"].as_str().unwrap().parse().unwrap();
    // The fixture session lasts ~13 s; pretend the user started that long ago.
    sqlx::query("update workouts set started_at = now() - interval '30 seconds' where id = $1")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    id
}

fn telemetry_json(workout_id: Uuid, bottom: f64) -> String {
    serde_json::to_string(&fixtures::session(
        workout_id, 10, 1_200.0, bottom, 165, true,
    ))
    .unwrap()
}

#[sqlx::test]
async fn records_a_valid_workout_exactly_once(db: PgPool) {
    seed_pot(&db, 1, &[ALICE, BOB]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    let raw = telemetry_json(workout_id, 82.0);
    let uri = format!("/api/workouts/{workout_id}/complete");
    let body = format!(r#"{{"telemetry":{raw}}}"#);

    let (status, first, _) = Call::post(&uri, body.clone())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["status"], "recorded");
    assert_eq!(first["tx_hash"], format!("{:#x}", B256::repeat_byte(0xab)));

    let (status, again, _) = Call::post(&uri, body).cookie(&cookie).send(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["tx_hash"], first["tx_hash"]);
    assert_eq!(oracle.calls.load(Ordering::SeqCst), 1);

    let (_, pot, _) = Call::get("/api/pots/1").send(&app).await;
    let alice = pot["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["address"] == ALICE)
        .unwrap();
    assert_eq!(alice["checked_in"], json!([0]));

    let evidence = format!("/api/evidence/{:#x}", evidence_hash(&raw));
    let (status, stored, _) = Call::get(&evidence).send(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored["workout_id"], workout_id.to_string());

    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[sqlx::test]
async fn rejects_implausible_telemetry_without_touching_the_chain(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    let uri = format!("/api/workouts/{workout_id}/complete");
    let body = format!(r#"{{"telemetry":{}}}"#, telemetry_json(workout_id, 120.0));

    let (status, res, _) = Call::post(&uri, body.clone())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(res["error"].as_str().unwrap().contains("deep enough"));

    let (status, _, _) = Call::post(&uri, body).cookie(&cookie).send(&app).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(oracle.calls.load(Ordering::SeqCst), 0);
}

#[sqlx::test]
async fn telemetry_from_another_workout_is_rejected(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let app = app(db.clone(), Arc::default());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    let body = format!(
        r#"{{"telemetry":{}}}"#,
        telemetry_json(Uuid::new_v4(), 82.0)
    );
    let (status, _, _) = Call::post(&format!("/api/workouts/{workout_id}/complete"), body)
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test]
async fn only_the_owner_can_complete_a_workout(db: PgPool) {
    seed_pot(&db, 1, &[ALICE, BOB]).await;
    let app = app(db.clone(), Arc::default());
    let alice = login(&db, ALICE).await;
    let bob = login(&db, BOB).await;

    let workout_id = start_workout(&app, &db, &alice).await;
    let body = format!(r#"{{"telemetry":{}}}"#, telemetry_json(workout_id, 82.0));
    let (status, _, _) = Call::post(&format!("/api/workouts/{workout_id}/complete"), body)
        .cookie(&bob)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn non_members_cannot_start_workouts(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let app = app(db.clone(), Arc::default());
    let cookie = login(&db, BOB).await;

    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn workouts_require_a_session(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let app = app(db.clone(), Arc::default());

    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&format!("{COOKIE}=forged"))
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn cross_origin_posts_are_blocked(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let app = app(db.clone(), Arc::default());
    let cookie = login(&db, ALICE).await;

    for origin in [None, Some("https://evil.example")] {
        let mut call =
            Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string()).cookie(&cookie);
        call.origin = origin;
        let (status, _, _) = call.send(&app).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
}

#[sqlx::test]
async fn sign_in_with_ethereum_round_trip(db: PgPool) {
    let app = app(db.clone(), Arc::default());
    let signer = PrivateKeySigner::random();

    let (_, nonce, _) = Call::get("/api/auth/nonce").send(&app).await;
    let message = format!(
        "pushpot.test wants you to sign in with your Ethereum account:\n{}\n\nSign in to PushPot\n\n\
         URI: {ORIGIN}\nVersion: 1\nChain ID: 5042\nNonce: {}\nIssued At: {}",
        signer.address().to_checksum(None),
        nonce["nonce"].as_str().unwrap(),
        Utc::now().to_rfc3339(),
    );
    let signature = hex::encode_prefixed(
        signer
            .sign_message_sync(message.as_bytes())
            .unwrap()
            .as_bytes(),
    );
    let body = json!({ "message": message, "signature": signature }).to_string();

    let (status, me, set_cookie) = Call::post("/api/auth/verify", body.clone())
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    let expected = format!("{:#x}", signer.address());
    assert_eq!(me["address"], expected);

    let set_cookie = set_cookie.unwrap();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("Secure"));
    assert!(set_cookie.contains("SameSite=Lax"));
    let cookie = set_cookie.split(';').next().unwrap();
    let (status, me, _) = Call::get("/api/me").cookie(cookie).send(&app).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["address"], expected);

    let (status, _, _) = Call::post("/api/auth/verify", body).send(&app).await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "nonce must be single-use"
    );
}

#[sqlx::test]
async fn sign_in_rejects_a_signature_from_someone_else(db: PgPool) {
    let app = app(db.clone(), Arc::default());
    let (claimed, actual) = (PrivateKeySigner::random(), PrivateKeySigner::random());

    let (_, nonce, _) = Call::get("/api/auth/nonce").send(&app).await;
    let message = format!(
        "pushpot.test wants you to sign in with your Ethereum account:\n{}\n\n\
         URI: {ORIGIN}\nVersion: 1\nChain ID: 5042\nNonce: {}\nIssued At: {}",
        claimed.address().to_checksum(None),
        nonce["nonce"].as_str().unwrap(),
        Utc::now().to_rfc3339(),
    );
    let signature = hex::encode_prefixed(
        actual
            .sign_message_sync(message.as_bytes())
            .unwrap()
            .as_bytes(),
    );
    let body = json!({ "message": message, "signature": signature }).to_string();

    let (status, _, cookie) = Call::post("/api/auth/verify", body).send(&app).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(cookie.is_none());
}
