//! Mirrors PushPot events into Postgres. It is the only writer for on-chain state. Arc has
//! deterministic finality, so there are no reorgs, and applying a log twice is harmless: every
//! write is an upsert or a no-op when repeated, and repeats arrive in block order.
//!
//! To keep RPC use low it doesn't poll. A WebSocket subscription delivers our contract's logs as
//! they land and they are applied as delivered. `eth_getLogs` only fills gaps: from the stored
//! cursor at startup, whenever the subscription reconnects, and every few seconds while it is
//! down. While it is up, the cursor moves to a head seen one idle interval earlier, at the cost of
//! a single `eth_blockNumber`, so a restart only rereads the last few minutes.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use alloy::{
    contract::Error as ContractError,
    primitives::{Address, U256},
    providers::{Provider, ProviderBuilder, WsConnect},
    rpc::types::{Filter, Log},
    sol_types::SolEventInterface,
};
use anyhow::{Context, Result};
use chrono::DateTime;
use futures_util::StreamExt;
use sqlx::{Connection, PgConnection, PgPool};
use tokio::sync::mpsc;
use url::Url;

use super::{Chain, IPushPot::IPushPotEvents, redact_url};
use crate::{
    auth::format_address,
    state::{AppState, PotEvent, PotEventKind},
};

/// Consecutive failed reads (2 s apart) after which the indexer is reported as stuck.
const STUCK_AFTER: u32 = 15;
/// Logs delivered together (one block often has several) are applied in one transaction.
const BATCH_WINDOW: Duration = Duration::from_millis(200);
/// After the subscription (re)connects, how long to wait before reading the gap: every block
/// the read then stops short of was produced after the subscription started, so it is delivered.
const SETTLE: Duration = Duration::from_secs(2);

/// What the subscription hands the indexer.
enum Feed {
    Log(Box<Log>),
    /// The subscription (re)connected, so logs may have landed unseen.
    Resync,
}

/// What the indexer woke up for.
enum Wake {
    Logs(Vec<Log>),
    Resync,
    /// An interval passed with nothing delivered.
    Idle,
    /// There is no subscription; the interval has passed.
    Polling,
}

pub async fn run(state: AppState) {
    let mut cursor = match load_cursor(&state.db, state.chain.deploy_block).await {
        Ok(cursor) => cursor,
        Err(err) => {
            tracing::error!(error = ?err, "indexer could not load its cursor");
            return;
        }
    };
    let live = Arc::new(AtomicBool::new(false));
    let (feed_tx, mut feed) = mpsc::channel(256);
    match state.config.ws_url.clone() {
        Some(url) => {
            tokio::spawn(watch(url, state.chain.contract, feed_tx, live.clone()));
        }
        None => drop(feed_tx),
    }
    tracing::info!(cursor, "indexer started");

    let mut reading = true;
    let mut failures = 0u32;
    // A head seen while the subscription was up. Once an idle interval has passed on the same
    // connection, every log up to it has been delivered, so the cursor can move there unread.
    let mut checkpoint: Option<u64> = None;
    loop {
        if reading {
            match read(&state, &mut cursor).await {
                Ok(()) => {
                    if failures >= STUCK_AFTER {
                        tracing::info!(cursor, failures, "indexer recovered");
                    }
                    failures = 0;
                    reading = false;
                    state.indexer_ready.store(true, Ordering::Relaxed);
                }
                Err(err) => {
                    failures += 1;
                    let error = redact_url(&format!("{err:#}"), &state.config.rpc_url);
                    if failures.is_multiple_of(STUCK_AFTER) {
                        tracing::error!(
                            %error,
                            cursor,
                            failures,
                            "indexer is stuck: joins and check-ins are not being indexed"
                        );
                    } else {
                        tracing::warn!(%error, cursor, "indexer read failed");
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            }
        }

        let up = live.load(Ordering::Relaxed);
        let interval = if up {
            state.config.indexer_idle_interval
        } else {
            state.config.indexer_interval
        };
        match wait(&mut feed, interval).await {
            Wake::Logs(logs) => {
                if let Err(err) = apply_delivered(&state, cursor, &logs).await {
                    let error = format!("{err:#}");
                    tracing::warn!(%error, "applying delivered logs failed; reading them instead");
                    reading = true;
                }
            }
            Wake::Resync => {
                checkpoint = None;
                tokio::time::sleep(SETTLE).await;
                reading = true;
            }
            Wake::Idle if up => match state.chain.provider.get_block_number().await {
                Ok(head) => {
                    if let Some(seen) = checkpoint.filter(|&seen| seen > cursor) {
                        match commit(&state, &[], Some(seen)).await {
                            Ok(()) => cursor = seen,
                            Err(err) => {
                                tracing::warn!(error = %format!("{err:#}"), "saving the cursor failed")
                            }
                        }
                    }
                    checkpoint = Some(head);
                }
                Err(err) => {
                    let error = redact_url(&err.to_string(), &state.config.rpc_url);
                    tracing::warn!(%error, "reading the head failed");
                }
            },
            Wake::Idle | Wake::Polling => {
                checkpoint = None;
                reading = true;
            }
        }
    }
}

/// Waits for delivered logs, a reconnect, or `interval` passing.
async fn wait(feed: &mut mpsc::Receiver<Feed>, interval: Duration) -> Wake {
    let first = tokio::select! {
        item = feed.recv() => item,
        () = tokio::time::sleep(interval) => return Wake::Idle,
    };
    match first {
        None => {
            tokio::time::sleep(interval).await;
            Wake::Polling
        }
        Some(Feed::Resync) => Wake::Resync,
        Some(Feed::Log(log)) => {
            let mut logs = vec![*log];
            tokio::time::sleep(BATCH_WINDOW).await;
            while let Ok(item) = feed.try_recv() {
                match item {
                    Feed::Log(log) => logs.push(*log),
                    // Reading the gap takes in these logs as well.
                    Feed::Resync => return Wake::Resync,
                }
            }
            Wake::Logs(logs)
        }
    }
}

/// Applies logs the subscription delivered. Those at or below the cursor were already read. The
/// cursor stays put: it only moves past blocks known to be complete.
async fn apply_delivered(state: &AppState, cursor: u64, logs: &[Log]) -> Result<()> {
    let fresh: Vec<Log> = logs
        .iter()
        .filter(|log| !log.removed && log.block_number.is_some_and(|block| block > cursor))
        .cloned()
        .collect();
    if fresh.is_empty() {
        return Ok(());
    }
    commit(state, &fresh, None).await
}

/// Keeps a log subscription open, reconnecting with backoff, and forwards what it delivers.
async fn watch(url: Url, contract: Address, feed: mpsc::Sender<Feed>, live: Arc<AtomicBool>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match ProviderBuilder::new()
            .connect_ws(WsConnect::new(url.as_str()))
            .await
        {
            Ok(provider) => match provider
                .subscribe_logs(&Filter::new().address(contract))
                .await
            {
                Ok(subscription) => {
                    live.store(true, Ordering::Relaxed);
                    backoff = Duration::from_secs(1);
                    tracing::info!("listening for contract events");
                    if feed.send(Feed::Resync).await.is_err() {
                        return;
                    }
                    let mut logs = subscription.into_stream();
                    while let Some(log) = logs.next().await {
                        if log.address() != contract {
                            continue;
                        }
                        if feed.send(Feed::Log(Box::new(log))).await.is_err() {
                            return;
                        }
                    }
                    live.store(false, Ordering::Relaxed);
                    tracing::warn!(
                        "contract event subscription ended; polling until it reconnects"
                    );
                }
                Err(err) => {
                    let error = redact_url(&err.to_string(), &url);
                    tracing::warn!(%error, "could not subscribe to contract events");
                }
            },
            Err(err) => {
                let error = redact_url(&err.to_string(), &url);
                tracing::warn!(%error, "could not open the event subscription");
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

async fn load_cursor(db: &PgPool, deploy_block: u64) -> Result<u64> {
    let stored: Option<i64> = sqlx::query_scalar("select last_block from indexer_state")
        .fetch_optional(db)
        .await?;
    Ok(stored.map_or(deploy_block.saturating_sub(1), |b| b as u64))
}

/// Reads and applies every log from the cursor up to the block before the head, moving the
/// cursor with each query.
async fn read(state: &AppState, cursor: &mut u64) -> Result<()> {
    // Behind a load balancer, the node answering `eth_getLogs` may be a block behind the one
    // that reported the head, and an empty answer for that block would never be revisited.
    let head = state
        .chain
        .provider
        .get_block_number()
        .await
        .context("block number")?
        .saturating_sub(1);
    while *cursor < head {
        let filter = Filter::new().address(state.chain.contract);
        let (logs, to) = state.chain.logs(&filter, *cursor + 1, head).await?;
        commit(state, &logs, Some(to)).await?;
        *cursor = to;
    }
    Ok(())
}

/// Applies the logs and, given a block, moves the cursor there in the same transaction; then
/// announces the events.
async fn commit(state: &AppState, logs: &[Log], to: Option<u64>) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let events = apply_logs(&mut tx, &state.chain, logs).await?;
    if let Some(to) = to {
        sqlx::query(
            "insert into indexer_state (id, last_block) values (true, $1)
             on conflict (id) do update set last_block = excluded.last_block",
        )
        .bind(to as i64)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    for event in events {
        let _ = state.events.send(event);
    }
    Ok(())
}

/// Applies a batch of logs and returns the events to broadcast. A log that can never be stored,
/// such as one with data an older deployment let through, is reported and skipped: retrying it
/// forever would stall every join and check-in behind it.
pub async fn apply_logs(
    db: &mut PgConnection,
    chain: &Chain,
    logs: &[Log],
) -> Result<Vec<PotEvent>> {
    let mut events = Vec::new();
    for log in logs {
        let mut savepoint = db.begin().await?;
        match apply(&mut savepoint, chain, log).await {
            Ok(event) => {
                savepoint.commit().await?;
                events.extend(event);
            }
            Err(err) if is_permanent(&err) => {
                savepoint.rollback().await?;
                tracing::error!(
                    error = %format!("{err:#}"),
                    block = log.block_number,
                    tx = ?log.transaction_hash,
                    log_index = log.log_index,
                    "skipping a log that can't be indexed"
                );
            }
            Err(err) => return Err(err),
        }
    }
    Ok(events)
}

/// Whether applying the log again would fail the same way: it couldn't be decoded or converted,
/// or Postgres rejected the data itself (SQLSTATE class 22) or a constraint (class 23). Anything
/// else, like a dropped connection or an RPC error, fails the batch so it is retried.
fn is_permanent(err: &anyhow::Error) -> bool {
    if err.downcast_ref::<ContractError>().is_some() {
        return false;
    }
    match err.downcast_ref::<sqlx::Error>() {
        Some(sqlx::Error::Database(db)) => db
            .code()
            .is_some_and(|code| code.starts_with("22") || code.starts_with("23")),
        Some(_) => false,
        None => true,
    }
}

/// Applies one log and returns the event to broadcast, if any.
async fn apply(db: &mut PgConnection, chain: &Chain, log: &Log) -> Result<Option<PotEvent>> {
    let decoded = match IPushPotEvents::decode_log(&log.inner) {
        Ok(decoded) => decoded,
        Err(err) if is_mirrored(log) => return Err(err).context("decoding log"),
        Err(_) => return Ok(None),
    };
    let tx_hash = log
        .transaction_hash
        .map(|h| format!("{h:#x}"))
        .unwrap_or_default();
    let block = log.block_number.unwrap_or_default() as i64;
    let event = |pot_id, kind, address, period, reps| PotEvent {
        pot_id,
        kind,
        address,
        period,
        reps,
        tx_hash: tx_hash.clone(),
    };

    Ok(match decoded.data {
        IPushPotEvents::PotCreated(e) => {
            let id = pot_id(e.potId)?;
            let start = DateTime::from_timestamp(e.startTime as i64, 0).context("start time")?;
            let fee_bps = chain.fee_bps(id as u64).await?;
            sqlx::query(
                "insert into pots (id, creator, title, stake, reps_per_period, periods,
                     period_seconds, start_time, max_members, created_tx, created_block, fee_bps)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 on conflict (id) do nothing",
            )
            .bind(id)
            .bind(format_address(e.creator))
            .bind(sanitize_title(&e.title))
            .bind(i64::try_from(e.stake).context("stake")?)
            .bind(i32::from(e.repsPerPeriod))
            .bind(i32::from(e.periods))
            .bind(e.periodSeconds as i32)
            .bind(start)
            .bind(i32::from(e.maxMembers))
            .bind(&tx_hash)
            .bind(block)
            .bind(i32::from(fee_bps))
            .execute(&mut *db)
            .await?;
            None
        }
        IPushPotEvents::ChallengeCreated(e) => {
            sqlx::query("update pots set official = true where id = $1")
                .bind(pot_id(e.potId)?)
                .execute(&mut *db)
                .await?;
            None
        }
        IPushPotEvents::FeeCollected(e) => {
            sqlx::query("update pots set fee_amount = $2, fee_tx = $3 where id = $1")
                .bind(pot_id(e.potId)?)
                .bind(i64::try_from(e.amount).context("fee amount")?)
                .bind(&tx_hash)
                .execute(&mut *db)
                .await?;
            None
        }
        IPushPotEvents::Joined(e) => {
            let (id, address) = (pot_id(e.potId)?, format_address(e.member));
            sqlx::query(
                "insert into members (pot_id, address, active, joined_tx) values ($1, $2, true, $3)
                 on conflict (pot_id, address) do update set active = true, joined_tx = excluded.joined_tx",
            )
            .bind(id)
            .bind(&address)
            .bind(&tx_hash)
            .execute(&mut *db)
            .await?;
            Some(event(id, PotEventKind::Joined, address, None, None))
        }
        IPushPotEvents::Left(e) => {
            let (id, address) = (pot_id(e.potId)?, format_address(e.member));
            sqlx::query("update members set active = false where pot_id = $1 and address = $2")
                .bind(id)
                .bind(&address)
                .execute(&mut *db)
                .await?;
            Some(event(id, PotEventKind::Left, address, None, None))
        }
        IPushPotEvents::CheckedIn(e) => {
            let (id, address) = (pot_id(e.potId)?, format_address(e.member));
            let (period, reps) = (i32::from(e.period), i32::from(e.reps));
            let inserted = insert_checkin(
                &mut *db,
                id,
                &address,
                period,
                reps,
                &format!("{:#x}", e.evidenceHash),
                &tx_hash,
                block,
            )
            .await?;
            // The oracle path writes and announces its own check-ins; only surface new ones here.
            inserted.then(|| {
                event(
                    id,
                    PotEventKind::CheckedIn,
                    address,
                    Some(period),
                    Some(reps),
                )
            })
        }
        IPushPotEvents::Claimed(e) => {
            let (id, address) = (pot_id(e.potId)?, format_address(e.member));
            sqlx::query(
                "update members set claimed_amount = $3, claimed_tx = $4 where pot_id = $1 and address = $2",
            )
            .bind(id)
            .bind(&address)
            .bind(i64::try_from(e.amount).context("claim amount")?)
            .bind(&tx_hash)
            .execute(&mut *db)
            .await?;
            Some(event(id, PotEventKind::Claimed, address, None, None))
        }
    })
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_checkin(
    db: &mut PgConnection,
    pot_id: i64,
    address: &str,
    period: i32,
    reps: i32,
    evidence_hash: &str,
    tx_hash: &str,
    block: i64,
) -> Result<bool> {
    let result = sqlx::query(
        "insert into checkins (pot_id, address, period, reps, evidence_hash, tx_hash, block_number)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (pot_id, address, period) do nothing",
    )
    .bind(pot_id)
    .bind(address)
    .bind(period)
    .bind(reps)
    .bind(evidence_hash)
    .bind(tx_hash)
    .bind(block)
    .execute(db)
    .await?;
    Ok(result.rows_affected() == 1)
}

fn pot_id(id: U256) -> Result<i64> {
    i64::try_from(id).context("pot id out of range")
}

/// Whether the log is one of the events we mirror, as opposed to ones we ignore like
/// `OracleUpdated`.
fn is_mirrored(log: &Log) -> bool {
    log.topic0()
        .is_some_and(|topic| IPushPotEvents::SELECTORS.contains(&topic.0))
}

/// Postgres text can't hold NUL, and control characters have no place in a title. The contract
/// rejects them, but earlier deployments didn't.
fn sanitize_title(title: &str) -> String {
    let printable: String = title.chars().filter(|c| !c.is_control()).collect();
    printable.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use alloy::{
        primitives::{Address, B256, Bytes, Log as PrimitiveLog, LogData},
        sol_types::{SolCall, SolEvent},
    };

    use super::*;
    use crate::{
        chain::{IPushPot, MAX_LOG_RANGE},
        testing,
    };

    /// `getPot`'s answer for a pot with this fee.
    fn pot_on_chain(fee_bps: u16) -> Bytes {
        let pot = IPushPot::Pot {
            creator: Address::repeat_byte(0xaa),
            startTime: 1_900_000_000,
            periodSeconds: 600,
            periods: 3,
            repsPerPeriod: 10,
            maxMembers: 5,
            memberCount: 0,
            completerCount: 0,
            claimedCount: 0,
            feeBps: fee_bps,
            feeCollected: false,
            official: false,
            stake: 1_000_000,
            paidOut: Default::default(),
            oracle: Address::repeat_byte(0x0c),
        };
        IPushPot::getPotCall::abi_encode_returns(&pot).into()
    }

    fn log(data: LogData) -> Log {
        Log {
            inner: PrimitiveLog {
                address: Address::ZERO,
                data,
            },
            block_number: Some(1),
            transaction_hash: Some(B256::repeat_byte(1)),
            ..Default::default()
        }
    }

    fn created(pot_id: u64, title: &str) -> Log {
        log(IPushPot::PotCreated {
            potId: U256::from(pot_id),
            creator: Address::repeat_byte(0xaa),
            title: title.into(),
            stake: 1_000_000,
            repsPerPeriod: 10,
            periods: 3,
            periodSeconds: 600,
            startTime: 1_900_000_000,
            maxMembers: 5,
        }
        .encode_log_data())
    }

    fn joined(pot_id: u64, member: Address) -> Log {
        log(IPushPot::Joined {
            potId: U256::from(pot_id),
            member,
        }
        .encode_log_data())
    }

    #[sqlx::test]
    async fn a_bad_log_does_not_hold_up_the_batch(db: PgPool) {
        let member = Address::repeat_byte(0xbb);
        let logs = [
            created(1, "\0gm\u{7}\n crew\0"),
            // Pot 9 was never created, so this violates a foreign key.
            joined(9, member),
            joined(1, member),
        ];

        let (state, rpc) = testing::state(db.clone(), Arc::default());
        rpc.push_success(&pot_on_chain(0));
        let mut tx = db.begin().await.unwrap();
        let events = apply_logs(&mut tx, &state.chain, &logs).await.unwrap();
        tx.commit().await.unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pot_id, 1);
        let title: String = sqlx::query_scalar("select title from pots where id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(title, "gm crew");
        let members: i64 = sqlx::query_scalar("select count(*) from members where pot_id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(members, 1);
    }

    #[sqlx::test]
    async fn indexes_challenges_fees_and_collections(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let logs = [
            created(2, "Daily 50 · Oct 14"),
            log(IPushPot::ChallengeCreated {
                potId: U256::from(2),
            }
            .encode_log_data()),
            log(IPushPot::FeeCollected {
                potId: U256::from(2),
                treasury: Address::repeat_byte(0x7e),
                amount: U256::from(150_000),
            }
            .encode_log_data()),
        ];

        rpc.push_success(&pot_on_chain(500));
        let mut tx = db.begin().await.unwrap();
        apply_logs(&mut tx, &state.chain, &logs).await.unwrap();
        tx.commit().await.unwrap();

        let pot: (bool, i32, Option<i64>) =
            sqlx::query_as("select official, fee_bps, fee_amount from pots where id = 2")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(pot, (true, 500, Some(150_000)));
    }

    #[sqlx::test]
    async fn an_rpc_failure_retries_the_batch_instead_of_skipping(db: PgPool) {
        let (state, _rpc) = testing::state(db.clone(), Arc::default());
        let mut tx = db.begin().await.unwrap();
        assert!(
            apply_logs(&mut tx, &state.chain, &[created(3, "gm")])
                .await
                .is_err()
        );
    }

    #[test]
    fn only_data_errors_are_skipped() {
        assert!(is_permanent(&anyhow::anyhow!("pot id out of range")));
        assert!(!is_permanent(&sqlx::Error::PoolTimedOut.into()));
        assert!(!is_permanent(
            &anyhow::Error::from(sqlx::Error::WorkerCrashed).context("insert")
        ));
    }

    async fn stored_cursor(db: &PgPool) -> Option<i64> {
        sqlx::query_scalar("select last_block from indexer_state")
            .fetch_optional(db)
            .await
            .unwrap()
    }

    fn at_block(mut log: Log, block: u64, index: u64) -> Log {
        log.block_number = Some(block);
        log.log_index = Some(index);
        log
    }

    #[sqlx::test]
    async fn reads_up_to_the_block_before_the_head(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());

        rpc.push_success(&"0xa");
        rpc.push_success(&Vec::<Log>::new());
        let mut cursor = 5;
        read(&state, &mut cursor).await.unwrap();
        assert_eq!(cursor, 9);
        assert_eq!(stored_cursor(&db).await, Some(9));

        rpc.push_success(&"0xa");
        read(&state, &mut cursor).await.unwrap();
        assert_eq!(cursor, 9);
        assert!(rpc.read_q().is_empty());
    }

    #[sqlx::test]
    async fn narrows_log_queries_the_provider_refuses(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let refusal = "Under the Free tier plan, you can make eth_getLogs requests with up to a \
                       10 block range.";

        // Head 31: the first query asks for blocks 6 to 30, then 6 to 7 after the refusal.
        rpc.push_success(&"0x1f");
        rpc.push_failure_msg(refusal);
        for _ in 0..13 {
            rpc.push_success(&Vec::<Log>::new());
        }
        let mut cursor = 5;
        read(&state, &mut cursor).await.unwrap();
        assert_eq!(cursor, 30);
        assert_eq!(state.chain.log_range.load(Ordering::Relaxed), 2);
        assert!(rpc.read_q().is_empty());
    }

    #[sqlx::test]
    async fn other_rpc_errors_are_not_mistaken_for_a_range_limit(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());

        rpc.push_success(&"0x1f");
        rpc.push_failure_msg("rate limited");
        let mut cursor = 5;
        assert!(read(&state, &mut cursor).await.is_err());
        assert_eq!(cursor, 5);
        assert_eq!(state.chain.log_range.load(Ordering::Relaxed), MAX_LOG_RANGE);
    }

    #[sqlx::test]
    async fn delivered_logs_are_applied_without_moving_the_cursor(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let member = Address::repeat_byte(0xbb);

        rpc.push_success(&pot_on_chain(0));
        let logs = [
            at_block(created(1, "gm"), 12, 0),
            at_block(joined(1, member), 12, 1),
        ];
        apply_delivered(&state, 5, &logs).await.unwrap();

        let members: i64 = sqlx::query_scalar("select count(*) from members where pot_id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(members, 1);
        assert_eq!(stored_cursor(&db).await, None);
    }

    #[sqlx::test]
    async fn delivered_logs_already_read_are_skipped(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());

        // Pot creation would read its fee from the chain; skipping it means no call at all.
        apply_delivered(&state, 12, &[at_block(created(1, "gm"), 12, 0)])
            .await
            .unwrap();
        assert!(rpc.read_q().is_empty());
        let pots: i64 = sqlx::query_scalar("select count(*) from pots")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(pots, 0);
    }

    #[sqlx::test]
    async fn replaying_logs_leaves_the_same_state(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let member = Address::repeat_byte(0xbb);
        let logs = [
            created(1, "gm"),
            joined(1, member),
            log(IPushPot::Left {
                potId: U256::from(1),
                member,
            }
            .encode_log_data()),
        ];

        for _ in 0..2 {
            rpc.push_success(&pot_on_chain(0));
            commit(&state, &logs, None).await.unwrap();
        }
        let active: Vec<bool> = sqlx::query_scalar("select active from members where pot_id = 1")
            .fetch_all(&db)
            .await
            .unwrap();
        assert_eq!(active, [false]);
    }

    #[tokio::test]
    async fn a_reconnect_during_a_batch_reads_instead() {
        let (tx, mut feed) = mpsc::channel(8);
        tx.send(Feed::Log(Box::default())).await.unwrap();
        tx.send(Feed::Resync).await.unwrap();
        assert!(matches!(
            wait(&mut feed, Duration::from_secs(60)).await,
            Wake::Resync
        ));
    }

    #[tokio::test]
    async fn logs_delivered_together_are_batched() {
        let (tx, mut feed) = mpsc::channel(8);
        for _ in 0..3 {
            tx.send(Feed::Log(Box::default())).await.unwrap();
        }
        let Wake::Logs(logs) = wait(&mut feed, Duration::from_secs(60)).await else {
            panic!("expected logs");
        };
        assert_eq!(logs.len(), 3);
    }
}
