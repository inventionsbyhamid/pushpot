use std::{sync::Arc, time::Duration};

use alloy::{
    hex,
    primitives::{B256, Bytes},
    signers::{SignerSync, local::PrivateKeySigner},
    sol_types::SolValue,
    transports::mock::Asserter,
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
use tokio::sync::Semaphore;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    http::RateLimiter,
    telemetry::{evidence_hash, fixtures},
    testing::{self, FakeOracle, ORIGIN},
};

const COOKIE: &str = "__Host-pushpot_session";
const ALICE: &str = "0x00000000000000000000000000000000000a11ce";
const BOB: &str = "0x0000000000000000000000000000000000000b0b";

fn app(db: PgPool, oracle: Arc<FakeOracle>) -> Router {
    crate::api::app(testing::state(db, oracle).0)
}

/// An app whose chain reads are answered from the returned queue.
fn app_with_rpc(db: PgPool, oracle: Arc<FakeOracle>) -> (Router, Asserter) {
    let (state, rpc) = testing::state(db, oracle);
    (crate::api::app(state), rpc)
}

/// The ABI-encoded `getMember` result.
fn member_on_chain(joined: bool) -> Bytes {
    Bytes::from((joined, false, 0u16, 0u128).abi_encode_params())
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

async fn complete(
    app: &Router,
    cookie: &str,
    workout_id: Uuid,
    telemetry: &str,
) -> (StatusCode, Value) {
    let (status, body, _) = Call::post(
        &format!("/api/workouts/{workout_id}/complete"),
        format!(r#"{{"telemetry":{telemetry}}}"#),
    )
    .cookie(cookie)
    .send(app)
    .await;
    (status, body)
}

/// Moves pot `id` far enough into the past that check-ins have closed.
async fn end_pot(db: &PgPool, id: i64) {
    sqlx::query("update pots set start_time = now() - interval '1 hour' where id = $1")
        .bind(id)
        .execute(db)
        .await
        .unwrap();
}

/// Inserts a workout for pot 1 the way an interrupted request or an older version could have
/// left it, submitted three minutes ago with its id as the evidence hash.
async fn insert_workout(db: &PgPool, address: &str, period: i32, status: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "insert into workouts (id, pot_id, address, period, reps_target, status, started_at,
             completed_at, evidence_hash)
         values ($1, 1, $2, $3, 10, $4, now() - interval '5 minutes', now() - interval '3 minutes',
             $1::text)",
    )
    .bind(id)
    .bind(address)
    .bind(period)
    .bind(status)
    .execute(db)
    .await
    .unwrap();
    id
}

async fn insert_checkin(db: &PgPool, address: &str, period: i32, evidence_hash: &str) {
    sqlx::query(
        "insert into checkins (pot_id, address, period, reps, evidence_hash, tx_hash, block_number)
         values (1, $1, $2, 10, $3, '0xfeed', 9)",
    )
    .bind(address)
    .bind(period)
    .bind(evidence_hash)
    .execute(db)
    .await
    .unwrap();
}

async fn workout_status(db: &PgPool, id: Uuid) -> String {
    sqlx::query_scalar("select status from workouts where id = $1")
        .bind(id)
        .fetch_one(db)
        .await
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
    assert_eq!(oracle.calls(), 1);

    let (_, pot, _) = Call::get("/api/pots/1").send(&app).await;
    let alice = pot["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["address"] == ALICE)
        .unwrap();
    assert_eq!(alice["checked_in"], json!([0]));

    let evidence = format!("/api/evidence/{:#x}", evidence_hash(&raw));
    let (status, _, _) = Call::get(&evidence).send(&app).await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "published only after the pot"
    );
    end_pot(&db, 1).await;
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
    assert_eq!(oracle.calls(), 0);
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
    let (app, rpc) = app_with_rpc(db.clone(), Arc::default());
    let cookie = login(&db, BOB).await;

    rpc.push_success(&member_on_chain(false));
    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn a_join_the_indexer_has_not_seen_yet_still_counts(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let (app, rpc) = app_with_rpc(db.clone(), Arc::default());
    let cookie = login(&db, BOB).await;

    rpc.push_success(&member_on_chain(true));
    let (status, body, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // With the chain unreachable, membership can't be ruled out either.
    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
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

#[sqlx::test]
async fn starting_again_reuses_the_open_workout(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let app = app(db.clone(), Arc::default());
    let cookie = login(&db, ALICE).await;

    let first = start_workout(&app, &db, &cookie).await;
    assert_eq!(start_workout(&app, &db, &cookie).await, first);

    sqlx::query("update workouts set status = 'failed' where id = $1")
        .bind(first)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(start_workout(&app, &db, &cookie).await, first);
}

#[sqlx::test]
async fn one_member_cannot_queue_many_check_ins_for_a_period(db: PgPool) {
    seed_pot(&db, 1, &[ALICE, BOB]).await;
    let oracle = Arc::new(FakeOracle {
        delay: Duration::from_millis(100),
        ..Default::default()
    });
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let mut ids = vec![];
    for _ in 0..10 {
        ids.push(start_workout(&app, &db, &cookie).await);
    }
    let attempts = ids.into_iter().map(|id| {
        let (app, cookie) = (app.clone(), cookie.clone());
        tokio::spawn(async move { complete(&app, &cookie, id, &telemetry_json(id, 82.0)).await })
    });
    for attempt in attempts {
        let (status, body) = attempt.await.unwrap();
        assert!(
            matches!(status, StatusCode::OK | StatusCode::CONFLICT),
            "{status} {body}"
        );
    }
    assert_eq!(oracle.calls(), 1);
}

#[sqlx::test]
async fn only_one_workout_per_period_can_be_in_flight(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    insert_workout(&db, ALICE, 0, "submitting").await;
    let stale = insert_workout(&db, ALICE, 0, "failed").await;

    let (status, body) = complete(&app, &cookie, stale, &telemetry_json(stale, 82.0)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("already being recorded")
    );
    assert_eq!(oracle.calls(), 0);

    let (status, _, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[sqlx::test]
async fn completing_a_checked_in_period_never_reaches_the_chain(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    insert_checkin(&db, ALICE, 0, "0xsomething-else").await;

    let (status, _) = complete(&app, &cookie, workout_id, &telemetry_json(workout_id, 82.0)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(oracle.calls(), 0);
}

#[sqlx::test]
async fn workout_requests_are_rate_limited_per_address(db: PgPool) {
    seed_pot(&db, 1, &[ALICE, BOB]).await;
    let (mut state, _) = testing::state(db.clone(), Arc::default());
    state.workout_limiter = Arc::new(RateLimiter::new(3, Duration::from_secs(60)));
    let app = crate::api::app(state);
    let (alice, bob) = (login(&db, ALICE).await, login(&db, BOB).await);

    let start = |cookie: String| {
        let app = app.clone();
        async move {
            Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
                .cookie(&cookie)
                .send(&app)
                .await
                .0
        }
    };
    for _ in 0..3 {
        assert_eq!(start(alice.clone()).await, StatusCode::OK);
    }
    assert_eq!(start(alice.clone()).await, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(start(bob.clone()).await, StatusCode::OK);
}

#[sqlx::test]
async fn a_dropped_request_still_records_the_check_in(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let oracle = Arc::new(FakeOracle {
        delay: Duration::from_millis(500),
        ..Default::default()
    });
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    let telemetry = telemetry_json(workout_id, 82.0);
    let request = complete(&app, &cookie, workout_id, &telemetry);
    let oracle_called = async {
        while oracle.calls() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    };
    // The client goes away while the check-in is being sent.
    tokio::select! {
        _ = request => panic!("the check-in finished before the client left"),
        () = oracle_called => {}
    }

    for _ in 0..50 {
        if workout_status(&db, workout_id).await != "submitting" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(oracle.calls(), 1);
    assert_eq!(workout_status(&db, workout_id).await, "recorded");
    let (status, body) = complete(&app, &cookie, workout_id, &telemetry).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[sqlx::test]
async fn stuck_submissions_are_settled_and_can_be_retried(db: PgPool) {
    seed_pot(&db, 1, &[ALICE, BOB]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());

    let landed = insert_workout(&db, ALICE, 0, "submitting").await;
    insert_checkin(&db, ALICE, 0, &landed.to_string()).await;
    let lost = insert_workout(&db, BOB, 0, "submitting").await;
    let pending = insert_workout(&db, ALICE, 1, "submitting").await;
    sqlx::query("update workouts set completed_at = now() where id = $1")
        .bind(pending)
        .execute(&db)
        .await
        .unwrap();

    assert_eq!(super::workouts::sweep_stuck(&db).await.unwrap(), 2);
    assert_eq!(workout_status(&db, landed).await, "recorded");
    assert_eq!(workout_status(&db, lost).await, "failed");
    assert_eq!(workout_status(&db, pending).await, "submitting");

    let bob = login(&db, BOB).await;
    let (status, body) = complete(&app, &bob, lost, &telemetry_json(lost, 82.0)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(oracle.calls(), 1);
}

#[sqlx::test]
async fn a_session_longer_than_the_server_saw_is_rejected(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let (_, body, _) = Call::post("/api/workouts", json!({ "pot_id": 1 }).to_string())
        .cookie(&cookie)
        .send(&app)
        .await;
    let workout_id: Uuid = body["workout_id"].as_str().unwrap().parse().unwrap();
    let (status, body) =
        complete(&app, &cookie, workout_id, &telemetry_json(workout_id, 82.0)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("longer than the session")
    );
    assert_eq!(oracle.calls(), 0);
}

#[sqlx::test]
async fn a_square_wave_forgery_is_rejected(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    let forged = serde_json::to_string(&fixtures::square_wave(workout_id, 10, false)).unwrap();
    let (status, body) = complete(&app, &cookie, workout_id, &forged).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(oracle.calls(), 0);
}

#[sqlx::test]
async fn another_members_trace_cannot_be_replayed(db: PgPool) {
    seed_pot(&db, 1, &[ALICE, BOB]).await;
    let oracle = Arc::new(FakeOracle::default());
    let app = app(db.clone(), oracle.clone());
    let (alice, bob) = (login(&db, ALICE).await, login(&db, BOB).await);

    let original = start_workout(&app, &db, &alice).await;
    let raw = telemetry_json(original, 82.0);
    assert_eq!(
        complete(&app, &alice, original, &raw).await.0,
        StatusCode::OK
    );

    let evidence = format!("/api/evidence/{:#x}", evidence_hash(&raw));
    assert_eq!(
        Call::get(&evidence).send(&app).await.0,
        StatusCode::NOT_FOUND
    );

    let replay = start_workout(&app, &db, &bob).await;
    let mut stolen: Value = serde_json::from_str(&raw).unwrap();
    stolen["workout_id"] = json!(replay);
    let (status, body) = complete(&app, &bob, replay, &stolen.to_string()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("already submitted")
    );
    assert_eq!(oracle.calls(), 1);
}

#[sqlx::test]
async fn rejected_telemetry_is_not_stored(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let app = app(db.clone(), Arc::default());
    let cookie = login(&db, ALICE).await;

    let workout_id = start_workout(&app, &db, &cookie).await;
    let junk = json!({
        "v": 1, "workout_id": workout_id, "duration_ms": 1.0, "reps": [],
        "trace": { "dt": "A".repeat(400 * 1024), "elbow": "", "body": "", "vis": "" },
    })
    .to_string();
    let (status, _) = complete(&app, &cookie, workout_id, &junk).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (telemetry, bytes, hash): (Option<String>, Option<i32>, Option<String>) = sqlx::query_as(
        "select telemetry, telemetry_bytes, evidence_hash from workouts where id = $1",
    )
    .bind(workout_id)
    .fetch_one(&db)
    .await
    .unwrap();
    assert_eq!(telemetry, None);
    assert_eq!(bytes, Some(junk.len() as i32));
    assert_eq!(hash, Some(format!("{:#x}", evidence_hash(&junk))));
}

#[sqlx::test]
async fn listing_pots_needs_a_session_and_shows_only_mine(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    seed_pot(&db, 2, &[BOB]).await;
    let app = app(db.clone(), Arc::default());

    for uri in ["/api/pots", "/api/pots?scope=open"] {
        assert_eq!(Call::get(uri).send(&app).await.0, StatusCode::UNAUTHORIZED);
    }

    let cookie = login(&db, ALICE).await;
    let (status, body, _) = Call::get("/api/pots?scope=mine")
        .cookie(&cookie)
        .send(&app)
        .await;
    assert_eq!(status, StatusCode::OK);
    let ids: Vec<i64> = body["pots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [1]);
}

async fn open_events(app: &Router, pot_id: i64) -> axum::response::Response {
    let req = Request::get(format!("/api/pots/{pot_id}/events"))
        .body(Body::empty())
        .unwrap();
    app.clone().oneshot(req).await.unwrap()
}

#[sqlx::test]
async fn event_streams_need_a_pot_and_a_free_slot(db: PgPool) {
    seed_pot(&db, 1, &[ALICE]).await;
    let (mut state, _) = testing::state(db.clone(), Arc::default());
    state.event_streams = Arc::new(Semaphore::new(1));
    let app = crate::api::app(state);

    assert_eq!(open_events(&app, 99).await.status(), StatusCode::NOT_FOUND);

    let first = open_events(&app, 1).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(
        open_events(&app, 1).await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(first);
    assert_eq!(open_events(&app, 1).await.status(), StatusCode::OK);
}
