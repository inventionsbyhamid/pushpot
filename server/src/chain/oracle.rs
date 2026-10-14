//! Sends transactions from the oracle key: check-ins, official challenges (the oracle key is also
//! the curator) and fee collection. A single task owns the key so transactions go out one at a
//! time and nonces never race.

use std::{
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};

use alloy::{
    contract::{Error as ContractError, SolCallBuilder},
    primitives::{Address, B256, U256},
    providers::{DynProvider, Provider, ProviderBuilder},
    rpc::types::TransactionReceipt,
    sol_types::{SolCall, SolEvent},
};
use tokio::sync::{mpsc, oneshot};
use url::Url;

use super::{
    IPushPot::{self, IPushPotErrors, PotParams},
    redact_url,
};
use crate::config::Config;

/// Arc drops transactions priced below its 20 gwei base-fee floor without a receipt.
const MIN_MAX_FEE: u128 = 20_000_000_000;
const PRIORITY_FEE: u128 = 1_000_000_000;
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(20);
/// Arc confirms in under a second, so the first look waits a little and later ones are spaced out.
const FIRST_RECEIPT_CHECK: Duration = Duration::from_millis(400);
const RECEIPT_POLL: Duration = Duration::from_millis(250);
/// Arc's base fee sits at its floor almost always, so a recent reading is good enough.
const GAS_PRICE_TTL: Duration = Duration::from_secs(60);
/// Jobs that waited longer than this are failed instead of sent, so a backlog drains quickly and
/// members can retry rather than wait on check-ins nobody is waiting for any more.
const MAX_QUEUE_WAIT: Duration = Duration::from_secs(30);

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

#[derive(Debug, Clone)]
pub struct CreatedChallenge {
    pub pot_id: u64,
    pub tx_hash: B256,
}

#[derive(Debug, Clone)]
pub struct CollectedFee {
    pub amount: U256,
    pub tx_hash: B256,
}

#[derive(Debug, thiserror::Error)]
pub enum OracleError {
    /// The member is already checked in for this period, possibly by an earlier attempt whose
    /// receipt we never saw.
    #[error("already checked in for this period")]
    AlreadyCheckedIn,
    /// The contract refused the transaction; retrying won't help.
    #[error("{0}")]
    Rejected(String),
    /// RPC or network trouble; the transaction may succeed if retried, or may even have landed.
    #[error("{0}")]
    Unavailable(String),
}

impl OracleError {
    fn redacted(self, rpc_url: &Url) -> Self {
        match self {
            Self::Unavailable(detail) => Self::Unavailable(redact_url(&detail, rpc_url)),
            other => other,
        }
    }
}

pub type OracleFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, OracleError>> + Send + 'a>>;

/// Transactions sent from the oracle key.
pub trait OracleSender: Send + Sync {
    fn check_in(&self, request: CheckInRequest) -> OracleFuture<'_, CheckInReceipt>;
    /// Opens an official challenge and returns its pot id, read from the receipt.
    fn create_challenge(&self, params: PotParams) -> OracleFuture<'_, CreatedChallenge>;
    /// Sends a finished pot's fee to the treasury.
    fn collect_fee(&self, pot_id: u64) -> OracleFuture<'_, CollectedFee>;
}

type Reply<T> = oneshot::Sender<Result<T, OracleError>>;

enum Action {
    CheckIn(CheckInRequest, Reply<CheckInReceipt>),
    CreateChallenge(PotParams, Reply<CreatedChallenge>),
    CollectFee(u64, Reply<CollectedFee>),
}

impl Action {
    fn kind(&self) -> &'static str {
        match self {
            Self::CheckIn(..) => "check-in",
            Self::CreateChallenge(..) => "create challenge",
            Self::CollectFee(..) => "collect fee",
        }
    }

    fn is_abandoned(&self) -> bool {
        match self {
            Self::CheckIn(_, reply) => reply.is_closed(),
            Self::CreateChallenge(_, reply) => reply.is_closed(),
            Self::CollectFee(_, reply) => reply.is_closed(),
        }
    }

    fn fail(self, err: OracleError) {
        match self {
            Self::CheckIn(_, reply) => {
                let _ = reply.send(Err(err));
            }
            Self::CreateChallenge(_, reply) => {
                let _ = reply.send(Err(err));
            }
            Self::CollectFee(_, reply) => {
                let _ = reply.send(Err(err));
            }
        }
    }
}

struct Job {
    action: Action,
    queued_at: Instant,
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
            .connect_client(super::rpc_client(&config.rpc_url))
            .erased();
        let (jobs, rx) = mpsc::channel(64);
        let worker = Worker::new(provider, config.contract, config.rpc_url.clone());
        tokio::spawn(worker.run(rx));
        Self { jobs }
    }

    fn enqueue<T: Send + 'static>(
        &self,
        action: impl FnOnce(Reply<T>) -> Action + Send + 'static,
    ) -> OracleFuture<'_, T> {
        Box::pin(async move {
            let (reply, rx) = oneshot::channel();
            let job = Job {
                action: action(reply),
                queued_at: Instant::now(),
            };
            self.jobs
                .send(job)
                .await
                .map_err(|_| OracleError::Unavailable("oracle is shutting down".into()))?;
            rx.await
                .map_err(|_| OracleError::Unavailable("oracle task stopped".into()))?
        })
    }
}

impl OracleSender for Oracle {
    fn check_in(&self, request: CheckInRequest) -> OracleFuture<'_, CheckInReceipt> {
        self.enqueue(|reply| Action::CheckIn(request, reply))
    }

    fn create_challenge(&self, params: PotParams) -> OracleFuture<'_, CreatedChallenge> {
        self.enqueue(|reply| Action::CreateChallenge(params, reply))
    }

    fn collect_fee(&self, pot_id: u64) -> OracleFuture<'_, CollectedFee> {
        self.enqueue(move |reply| Action::CollectFee(pot_id, reply))
    }
}

struct Worker {
    provider: DynProvider,
    pot: IPushPot::IPushPotInstance<DynProvider>,
    rpc_url: Url,
    gas_price: std::sync::Mutex<Option<(u128, Instant)>>,
}

impl Worker {
    fn new(provider: DynProvider, contract: Address, rpc_url: Url) -> Self {
        let pot = IPushPot::new(contract, provider.clone());
        Self {
            provider,
            pot,
            rpc_url,
            gas_price: std::sync::Mutex::default(),
        }
    }

    async fn gas_price(&self) -> Result<u128, OracleError> {
        let cached = *self.gas_price.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((price, _)) = cached.filter(|(_, at)| at.elapsed() < GAS_PRICE_TTL) {
            return Ok(price);
        }
        let price = self.provider.get_gas_price().await.map_err(unavailable)?;
        *self.gas_price.lock().unwrap_or_else(|e| e.into_inner()) = Some((price, Instant::now()));
        Ok(price)
    }

    async fn run(self, mut jobs: mpsc::Receiver<Job>) {
        while let Some(Job { action, queued_at }) = jobs.recv().await {
            if action.is_abandoned() {
                tracing::warn!(job = action.kind(), "oracle job abandoned");
                continue;
            }
            if queued_at.elapsed() > MAX_QUEUE_WAIT {
                tracing::warn!(job = action.kind(), "oracle job expired in queue");
                action.fail(OracleError::Unavailable(
                    "the oracle queue is backed up".into(),
                ));
                continue;
            }
            match action {
                Action::CheckIn(request, reply) => {
                    let _ = reply.send(self.check_in(&request).await);
                }
                Action::CreateChallenge(params, reply) => {
                    let _ = reply.send(self.create_challenge(params).await);
                }
                Action::CollectFee(pot_id, reply) => {
                    let _ = reply.send(self.collect_fee(pot_id).await);
                }
            }
        }
    }

    async fn check_in(&self, req: &CheckInRequest) -> Result<CheckInReceipt, OracleError> {
        let started = Instant::now();
        let call = self.pot.checkIn(
            U256::from(req.pot_id),
            req.member,
            req.period,
            req.reps,
            req.evidence,
        );
        let receipt = match self.send(call).await {
            Ok(receipt) => receipt,
            Err(err) => {
                tracing::warn!(pot_id = req.pot_id, error = %err, "check-in failed");
                return Err(err);
            }
        };
        let latency_ms = started.elapsed().as_millis() as u64;
        tracing::info!(
            pot_id = req.pot_id,
            member = %req.member,
            period = req.period,
            tx = %receipt.transaction_hash,
            latency_ms,
            cost_usdc = cost_usdc(&receipt),
            "check-in recorded"
        );
        Ok(CheckInReceipt {
            tx_hash: receipt.transaction_hash,
            block_number: receipt.block_number.unwrap_or_default(),
            latency_ms,
        })
    }

    async fn create_challenge(&self, params: PotParams) -> Result<CreatedChallenge, OracleError> {
        let title = params.title.clone();
        let receipt = self.send(self.pot.createChallenge(params)).await?;
        let tx_hash = receipt.transaction_hash;
        let pot_id = event::<IPushPot::PotCreated>(&receipt, *self.pot.address())
            .and_then(|created| u64::try_from(created.potId).ok())
            .ok_or_else(|| {
                OracleError::Unavailable(format!("{tx_hash} created no readable pot"))
            })?;
        tracing::info!(
            pot_id,
            %title,
            tx = %tx_hash,
            cost_usdc = cost_usdc(&receipt),
            "challenge created"
        );
        Ok(CreatedChallenge { pot_id, tx_hash })
    }

    async fn collect_fee(&self, pot_id: u64) -> Result<CollectedFee, OracleError> {
        let receipt = self.send(self.pot.collectFee(U256::from(pot_id))).await?;
        let amount = event::<IPushPot::FeeCollected>(&receipt, *self.pot.address())
            .map_or(U256::ZERO, |collected| collected.amount);
        tracing::info!(
            pot_id,
            %amount,
            tx = %receipt.transaction_hash,
            cost_usdc = cost_usdc(&receipt),
            "fee collected"
        );
        Ok(CollectedFee {
            amount,
            tx_hash: receipt.transaction_hash,
        })
    }

    /// Sends the call and waits for a successful receipt. Estimating gas runs the call, so a
    /// contract rejection comes back as a readable error before anything is sent.
    async fn send<C: SolCall + Send + Sync>(
        &self,
        call: SolCallBuilder<&DynProvider, C>,
    ) -> Result<TransactionReceipt, OracleError> {
        let sent = async {
            let gas_price = self.gas_price().await?;
            let pending = call
                .max_fee_per_gas((gas_price * 2).max(MIN_MAX_FEE))
                .max_priority_fee_per_gas(PRIORITY_FEE)
                .send()
                .await
                .map_err(classify)?;
            let tx_hash = *pending.tx_hash();

            let deadline = Instant::now() + RECEIPT_TIMEOUT;
            tokio::time::sleep(FIRST_RECEIPT_CHECK).await;
            loop {
                if let Some(receipt) = self
                    .provider
                    .get_transaction_receipt(tx_hash)
                    .await
                    .map_err(unavailable)?
                {
                    if !receipt.status() {
                        tracing::warn!(tx = %tx_hash, "transaction reverted");
                        return Err(OracleError::Rejected("the transaction reverted".into()));
                    }
                    return Ok(receipt);
                }
                if Instant::now() > deadline {
                    return Err(OracleError::Unavailable(format!(
                        "{tx_hash} not confirmed yet"
                    )));
                }
                tokio::time::sleep(RECEIPT_POLL).await;
            }
        };
        sent.await.map_err(|err| err.redacted(&self.rpc_url))
    }
}

/// The first `E` the contract emitted in this transaction.
fn event<E: SolEvent>(receipt: &TransactionReceipt, contract: Address) -> Option<E> {
    receipt
        .logs()
        .iter()
        .filter(|log| log.address() == contract)
        .find_map(|log| E::decode_log_data(log.data()).ok())
}

/// Gas is paid in native USDC, which has 18 decimals.
fn cost_usdc(receipt: &TransactionReceipt) -> f64 {
    receipt.gas_used as f64 * receipt.effective_gas_price as f64 / 1e18
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
        IPushPotErrors::InvalidParams(_) => "the contract refused these parameters",
        IPushPotErrors::NotCurator(_) => "the oracle key isn't the curator",
        IPushPotErrors::NotEnded(_) => "the pot hasn't ended",
        IPushPotErrors::NothingToClaim(_) => "nothing to collect",
        // A paused contract, or this pot's oracle was rotated or revoked.
        IPushPotErrors::Paused(_) | IPushPotErrors::NotOracle(_) => {
            return OracleError::Unavailable("the contract isn't accepting this right now".into());
        }
    };
    OracleError::Rejected(reason.into())
}

fn unavailable(err: impl std::fmt::Display) -> OracleError {
    OracleError::Unavailable(err.to_string())
}

#[cfg(test)]
mod tests {
    use alloy::{
        primitives::{LogData, U256},
        providers::ProviderBuilder,
        sol_types::{SolEvent, SolInterface},
        transports::{RpcError, mock::Asserter},
    };
    use serde_json::json;

    use super::*;

    fn check_in(
        queued_at: Instant,
    ) -> (Job, oneshot::Receiver<Result<CheckInReceipt, OracleError>>) {
        let (reply, rx) = oneshot::channel();
        let request = CheckInRequest {
            pot_id: 1,
            member: Address::ZERO,
            period: 0,
            reps: 10,
            evidence: B256::ZERO,
        };
        let job = Job {
            action: Action::CheckIn(request, reply),
            queued_at,
        };
        (job, rx)
    }

    #[tokio::test]
    async fn skips_abandoned_and_expired_jobs_without_sending() {
        let rpc = Asserter::new();
        // Any RPC call the worker makes would consume this.
        rpc.push_success(&"0x");
        let provider = ProviderBuilder::new()
            .connect_mocked_client(rpc.clone())
            .erased();
        let (jobs, rx) = mpsc::channel(4);
        let worker = Worker::new(provider, Address::ZERO, "https://rpc.test".parse().unwrap());
        let worker = tokio::spawn(worker.run(rx));

        let (abandoned, receiver) = check_in(Instant::now());
        drop(receiver);
        jobs.send(abandoned).await.unwrap();
        let (expired, receiver) =
            check_in(Instant::now() - MAX_QUEUE_WAIT - Duration::from_secs(1));
        jobs.send(expired).await.unwrap();

        let result = receiver.await.unwrap();
        assert!(
            matches!(&result, Err(OracleError::Unavailable(detail)) if detail.contains("backed up")),
            "{result:?}"
        );
        drop(jobs);
        worker.await.unwrap();
        assert_eq!(rpc.read_q().len(), 1);
    }

    fn receipt(logs: &[(Address, LogData)]) -> TransactionReceipt {
        let logs: Vec<_> = logs
            .iter()
            .enumerate()
            .map(|(i, (address, data))| {
                json!({
                    "address": address,
                    "topics": data.topics(),
                    "data": data.data,
                    "blockHash": B256::repeat_byte(2),
                    "blockNumber": "0x9",
                    "transactionHash": B256::repeat_byte(1),
                    "transactionIndex": "0x0",
                    "logIndex": format!("{i:#x}"),
                    "removed": false,
                })
            })
            .collect();
        serde_json::from_value(json!({
            "type": "0x2",
            "status": "0x1",
            "cumulativeGasUsed": "0x0",
            "logs": logs,
            "logsBloom": format!("0x{}", "00".repeat(256)),
            "transactionHash": B256::repeat_byte(1),
            "transactionIndex": "0x0",
            "blockHash": B256::repeat_byte(2),
            "blockNumber": "0x9",
            "gasUsed": "0x30d40",
            "effectiveGasPrice": "0x4a817c800",
            "from": Address::repeat_byte(3),
            "to": Address::repeat_byte(4),
        }))
        .unwrap()
    }

    #[test]
    fn reads_events_only_from_our_contract() {
        let contract = Address::repeat_byte(0xcc);
        let created = |pot_id: u64| {
            IPushPot::PotCreated {
                potId: U256::from(pot_id),
                creator: Address::repeat_byte(0xaa),
                title: "Daily 20 · Oct 14".into(),
                stake: 1_000_000,
                repsPerPeriod: 20,
                periods: 1,
                periodSeconds: 86_400,
                startTime: 1_800_000_000,
                maxMembers: 1_000,
            }
            .encode_log_data()
        };
        let receipt = receipt(&[
            (Address::repeat_byte(0xee), created(666)),
            (contract, created(42)),
        ]);

        let created = event::<IPushPot::PotCreated>(&receipt, contract).unwrap();
        assert_eq!(created.potId, U256::from(42));
        assert!(event::<IPushPot::FeeCollected>(&receipt, contract).is_none());
        assert!((cost_usdc(&receipt) - 0.004).abs() < 1e-9);
    }

    #[test]
    fn a_refused_gas_estimate_reads_as_the_contract_error() {
        let revert = IPushPotErrors::PotNotFound(IPushPot::PotNotFound {}).abi_encode();
        let payload = serde_json::from_value(json!({
            "code": 3,
            "message": "execution reverted",
            "data": alloy::primitives::Bytes::from(revert),
        }))
        .unwrap();
        let err = ContractError::TransportError(RpcError::ErrorResp(payload));
        assert!(matches!(
            classify(err),
            OracleError::Rejected(reason) if reason == "pot not found"
        ));
    }
}
