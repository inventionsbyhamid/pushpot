//! Application state for tests: chain reads are answered from a queue of canned RPC responses,
//! and check-ins go to a fake oracle.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use alloy::{
    primitives::{Address, B256, U256},
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    transports::mock::Asserter,
};
use sqlx::PgPool;
use tokio::sync::{Semaphore, broadcast};

use crate::{
    api::challenges::ChallengeCache,
    chain::{
        Chain,
        IPushPot::PotParams,
        oracle::{
            CheckInReceipt, CheckInRequest, CollectedFee, CreatedChallenge, OracleError,
            OracleFuture, OracleSender,
        },
    },
    config::Config,
    http::RateLimiter,
    state::AppState,
};

pub const ORIGIN: &str = "https://pushpot.test";

/// Pot ids handed out by `FakeOracle::create_challenge`, counting up from here.
pub const FIRST_CHALLENGE_ID: u64 = 1_000;
pub const COLLECTED_FEE: u64 = 250_000;

#[derive(Debug, Default, Clone, Copy)]
pub enum Outcome {
    #[default]
    Confirmed,
    /// The contract refused it; nothing landed.
    Refused,
    /// Sent, but never confirmed.
    Lost,
}

#[derive(Default)]
pub struct FakeOracle {
    pub calls: AtomicUsize,
    /// How long each check-in takes to confirm.
    pub delay: Duration,
    /// Every challenge it was asked to open, whatever the outcome.
    pub challenges: Mutex<Vec<PotParams>>,
    pub challenge_outcome: Mutex<Outcome>,
    pub collected: Mutex<Vec<u64>>,
}

impl FakeOracle {
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub fn challenge_titles(&self) -> Vec<String> {
        let challenges = self.challenges.lock().unwrap();
        challenges
            .iter()
            .map(|params| params.title.clone())
            .collect()
    }
}

impl OracleSender for FakeOracle {
    fn check_in(&self, _: CheckInRequest) -> OracleFuture<'_, CheckInReceipt> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            tokio::time::sleep(self.delay).await;
            Ok(CheckInReceipt {
                tx_hash: B256::repeat_byte(0xab),
                block_number: 7,
                latency_ms: 640,
            })
        })
    }

    fn create_challenge(&self, params: PotParams) -> OracleFuture<'_, CreatedChallenge> {
        let mut challenges = self.challenges.lock().unwrap();
        challenges.push(params);
        let pot_id = FIRST_CHALLENGE_ID + challenges.len() as u64 - 1;
        let result = match *self.challenge_outcome.lock().unwrap() {
            Outcome::Confirmed => Ok(CreatedChallenge {
                pot_id,
                tx_hash: B256::repeat_byte(0xcc),
            }),
            Outcome::Refused => Err(OracleError::Rejected("invalid parameters".into())),
            Outcome::Lost => Err(OracleError::Unavailable("not confirmed yet".into())),
        };
        Box::pin(async { result })
    }

    fn collect_fee(&self, pot_id: u64) -> OracleFuture<'_, CollectedFee> {
        self.collected.lock().unwrap().push(pot_id);
        Box::pin(async {
            Ok(CollectedFee {
                amount: U256::from(COLLECTED_FEE),
                tx_hash: B256::repeat_byte(0xfe),
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
        ws_url: None,
        indexer_interval: Duration::from_secs(1),
        indexer_idle_interval: Duration::from_secs(60),
        curator_enabled: true,
        fee_collector_enabled: false,
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
        challenge_cache: Arc::new(ChallengeCache::default()),
        index_html: None,
        indexer_ready: Arc::new(true.into()),
    };
    (state, rpc)
}
