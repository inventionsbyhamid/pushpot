//! Submits check-ins on behalf of the server. A single task owns the oracle key so transactions
//! go out one at a time and nonces never race.

use std::{
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};

use alloy::{
    contract::Error as ContractError,
    primitives::{Address, B256, U256},
    providers::{DynProvider, Provider, ProviderBuilder},
};
use tokio::sync::{mpsc, oneshot};

use super::IPushPot::{self, IPushPotErrors};
use crate::config::Config;

/// Arc drops transactions priced below its 20 gwei base-fee floor without a receipt.
const MIN_MAX_FEE: u128 = 20_000_000_000;
const PRIORITY_FEE: u128 = 1_000_000_000;
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(20);
const RECEIPT_POLL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone)]
pub struct CheckInRequest {
    pub pot_id: u64,
    pub member: Address,
    pub period: u16,
    pub reps: u16,
    pub evidence: B256,
}

#[derive(Debug, Clone)]
pub struct CheckInReceipt {
    pub tx_hash: B256,
    pub block_number: u64,
    pub latency_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum OracleError {
    /// The member is already checked in for this period, possibly by an earlier attempt whose
    /// receipt we never saw.
    #[error("already checked in for this period")]
    AlreadyCheckedIn,
    /// The contract refused the check-in; retrying won't help.
    #[error("{0}")]
    Rejected(String),
    /// RPC or network trouble; the check-in may succeed if retried.
    #[error("{0}")]
    Unavailable(String),
}

pub type CheckInFuture<'a> =
    Pin<Box<dyn Future<Output = Result<CheckInReceipt, OracleError>> + Send + 'a>>;

pub trait CheckInSender: Send + Sync {
    fn check_in(&self, request: CheckInRequest) -> CheckInFuture<'_>;
}

struct Job {
    request: CheckInRequest,
    reply: oneshot::Sender<Result<CheckInReceipt, OracleError>>,
}

pub struct Oracle {
    jobs: mpsc::Sender<Job>,
}

impl Oracle {
    pub fn spawn(config: &Config) -> Self {
        let provider = ProviderBuilder::new()
            .disable_recommended_fillers()
            .with_gas_estimation()
            .with_simple_nonce_management()
            .with_chain_id(config.chain_id)
            .wallet(config.oracle_signer.clone())
            .connect_http(config.rpc_url.clone())
            .erased();
        let (jobs, rx) = mpsc::channel(64);
        tokio::spawn(worker(provider, config.contract, rx));
        Self { jobs }
    }
}

impl CheckInSender for Oracle {
    fn check_in(&self, request: CheckInRequest) -> CheckInFuture<'_> {
        Box::pin(async move {
            let (reply, rx) = oneshot::channel();
            self.jobs
                .send(Job { request, reply })
                .await
                .map_err(|_| OracleError::Unavailable("oracle is shutting down".into()))?;
            rx.await
                .map_err(|_| OracleError::Unavailable("oracle task stopped".into()))?
        })
    }
}

async fn worker(provider: DynProvider, contract: Address, mut jobs: mpsc::Receiver<Job>) {
    let pot = IPushPot::new(contract, provider.clone());
    while let Some(job) = jobs.recv().await {
        let result = submit(&provider, &pot, &job.request).await;
        match &result {
            Ok(receipt) => tracing::info!(
                pot_id = job.request.pot_id,
                member = %job.request.member,
                period = job.request.period,
                tx = %receipt.tx_hash,
                latency_ms = receipt.latency_ms,
                "check-in recorded"
            ),
            Err(err) => {
                tracing::warn!(pot_id = job.request.pot_id, error = %err, "check-in failed")
            }
        }
        let _ = job.reply.send(result);
    }
}

async fn submit(
    provider: &DynProvider,
    pot: &IPushPot::IPushPotInstance<DynProvider>,
    req: &CheckInRequest,
) -> Result<CheckInReceipt, OracleError> {
    let started = Instant::now();
    let call = pot.checkIn(
        U256::from(req.pot_id),
        req.member,
        req.period,
        req.reps,
        req.evidence,
    );

    // Simulate first so contract rejections come back as readable errors instead of a mined revert.
    call.call().await.map_err(classify)?;

    let gas_price = provider.get_gas_price().await.map_err(unavailable)?;
    let pending = call
        .max_fee_per_gas((gas_price * 2).max(MIN_MAX_FEE))
        .max_priority_fee_per_gas(PRIORITY_FEE)
        .send()
        .await
        .map_err(classify)?;
    let tx_hash = *pending.tx_hash();

    let deadline = Instant::now() + RECEIPT_TIMEOUT;
    loop {
        if let Some(receipt) = provider
            .get_transaction_receipt(tx_hash)
            .await
            .map_err(unavailable)?
        {
            if !receipt.status() {
                return Err(OracleError::Rejected(
                    "check-in transaction reverted".into(),
                ));
            }
            return Ok(CheckInReceipt {
                tx_hash,
                block_number: receipt.block_number.unwrap_or_default(),
                latency_ms: started.elapsed().as_millis() as u64,
            });
        }
        if Instant::now() > deadline {
            return Err(OracleError::Unavailable(format!(
                "check-in {tx_hash} not confirmed yet"
            )));
        }
        tokio::time::sleep(RECEIPT_POLL).await;
    }
}

fn classify(err: ContractError) -> OracleError {
    let Some(decoded) = err.as_decoded_interface_error::<IPushPotErrors>() else {
        return unavailable(err);
    };
    let reason = match decoded {
        IPushPotErrors::AlreadyCheckedIn(_) => return OracleError::AlreadyCheckedIn,
        IPushPotErrors::OutsideWindow(_) => "this period has closed",
        IPushPotErrors::NotMember(_) => "not a member of this pot",
        IPushPotErrors::NotEnoughReps(_) => "not enough reps for this pot",
        IPushPotErrors::PotNotFound(_) => "pot not found",
        IPushPotErrors::Paused(_) | IPushPotErrors::NotOracle(_) => {
            return OracleError::Unavailable("check-ins are temporarily unavailable".into());
        }
    };
    OracleError::Rejected(reason.into())
}

fn unavailable(err: impl std::fmt::Display) -> OracleError {
    OracleError::Unavailable(err.to_string())
}
