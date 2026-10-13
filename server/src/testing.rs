//! Application state for tests: chain reads are answered from a queue of canned RPC responses,
//! and check-ins go to a fake oracle.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use alloy::{
    primitives::{Address, B256},
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    transports::mock::Asserter,
};
use sqlx::PgPool;
use tokio::sync::{Semaphore, broadcast};

use crate::{
    chain::{
        Chain,
        oracle::{CheckInFuture, CheckInReceipt, CheckInRequest, CheckInSender, OracleError},
    },
    config::Config,
    http::RateLimiter,
    state::AppState,
};

pub const ORIGIN: &str = "https://pushpot.test";

#[derive(Default)]
pub struct FakeOracle {
    pub calls: AtomicUsize,
    /// How long each check-in takes to confirm.
    pub delay: Duration,
}

impl FakeOracle {
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl CheckInSender for FakeOracle {
    fn check_in(&self, _: CheckInRequest) -> CheckInFuture<'_> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            tokio::time::sleep(self.delay).await;
            Ok::<_, OracleError>(CheckInReceipt {
                tx_hash: B256::repeat_byte(0xab),
                block_number: 7,
                latency_ms: 640,
            })
        })
    }
}

/// Returns the state and the queue its chain reads are answered from.
pub fn state(db: PgPool, oracle: Arc<FakeOracle>) -> (AppState, Asserter) {
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
    let rpc = Asserter::new();
    let chain = Chain {
        provider: ProviderBuilder::new()
            .connect_mocked_client(rpc.clone())
            .erased(),
        contract: Address::ZERO,
        chain_id: 5042,
        deploy_block: 0,
    };
    let state = AppState {
        db,
        config: Arc::new(config),
        chain,
        oracle,
        events: broadcast::channel(16).0,
        auth_limiter: Arc::new(RateLimiter::new(100, Duration::from_secs(60))),
        workout_limiter: Arc::new(RateLimiter::new(100, Duration::from_secs(60))),
        event_streams: Arc::new(Semaphore::new(10)),
        index_html: None,
    };
    (state, rpc)
}
