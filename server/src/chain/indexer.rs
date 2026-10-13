//! Mirrors PushPot events into Postgres. It is the only writer for on-chain state: each batch of
//! logs is applied in the same transaction that advances the block cursor, so every log is
//! applied exactly once and in order. Arc has deterministic finality, so there are no reorgs.
//!
//! To keep RPC use low it doesn't poll every block. A WebSocket subscription announces our
//! contract's logs as they land, and the indexer then reads them with `eth_getLogs` as usual; the
//! announcement is only a wake up call, so it can't skip or reorder anything. A slow safety poll
//! covers whatever the subscription misses, and polling speeds up while it's down.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use alloy::{
    contract::Error as ContractError,
    primitives::{Address, B256, U256},
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

/// RPC providers cap `eth_getLogs` at 10,000 blocks per query.
pub const MAX_RANGE: u64 = 9_999;
/// Consecutive failed ticks (2 s apart) after which the indexer is reported as stuck.
const STUCK_AFTER: u32 = 15;
/// Logs announced together (one block often has several) are read in one query.
const BATCH_WINDOW: Duration = Duration::from_millis(200);
/// How long to wait for the node answering `eth_getLogs` to catch up with an announcement, and
/// how many times, before falling back to the regular poll.
const LAG_RETRY: Duration = Duration::from_millis(300);
const LAG_RETRIES: u32 = 20;

/// A log the subscription announced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Announced {
    block: u64,
    tx: B256,
    index: u64,
}

enum Wake {
    Log(Announced),
    /// The subscription (re)connected, so logs may have landed unannounced.
    Resync,
}

/// What a pass over the chain achieved.
#[derive(Debug, PartialEq, Eq)]
enum Pass {
    /// Indexed everything it set out to.
    Done,
    /// Stopped at the `eth_getLogs` range limit; run again straight away.
    More,
    /// The node answering hasn't seen an announced log yet; nothing was applied.
    Lagging,
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
    let (wake_tx, mut wakes) = mpsc::channel(256);
    match state.config.ws_url.clone() {
        Some(url) => {
            tokio::spawn(watch(url, state.chain.contract, wake_tx, live.clone()));
        }
        None => drop(wake_tx),
    }
    tracing::info!(cursor, "indexer started");

    let mut announced: Vec<Announced> = Vec::new();
    let mut failures = 0u32;
    let mut lagging = 0u32;
    loop {
        let result = if announced.is_empty() {
            tick(&state, cursor).await
        } else {
            catch_up(&state, cursor, &announced).await
        };
        match result {
            Ok((next, pass)) => {
                if failures >= STUCK_AFTER {
                    tracing::info!(cursor = next, failures, "indexer recovered");
                }
                failures = 0;
                cursor = next;
                announced.retain(|log| log.block > cursor);
                match pass {
                    Pass::More => {}
                    Pass::Lagging if lagging < LAG_RETRIES => {
                        lagging += 1;
                        tokio::time::sleep(LAG_RETRY).await;
                    }
                    Pass::Lagging => {
                        tracing::warn!(cursor, "announced logs never showed up; polling instead");
                        lagging = 0;
                        announced.clear();
                    }
                    Pass::Done => {
                        lagging = 0;
                        state.indexer_ready.store(true, Ordering::Relaxed);
                        if announced.is_empty() {
                            let interval = if live.load(Ordering::Relaxed) {
                                state.config.indexer_idle_interval
                            } else {
                                state.config.indexer_interval
                            };
                            wait(&mut wakes, &mut announced, interval).await;
                        }
                    }
                }
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
                    tracing::warn!(%error, cursor, "indexer tick failed");
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

/// Sleeps until the subscription announces a log or `interval` passes.
async fn wait(
    wakes: &mut mpsc::Receiver<Wake>,
    announced: &mut Vec<Announced>,
    interval: Duration,
) {
    let wake = tokio::select! {
        wake = wakes.recv() => wake,
        () = tokio::time::sleep(interval) => return,
    };
    match wake {
        // No subscription: plain polling.
        None => tokio::time::sleep(interval).await,
        Some(Wake::Resync) => {}
        Some(Wake::Log(log)) => {
            announced.push(log);
            tokio::time::sleep(BATCH_WINDOW).await;
            while let Ok(wake) = wakes.try_recv() {
                if let Wake::Log(log) = wake {
                    announced.push(log);
                }
            }
        }
    }
}

/// Keeps a log subscription open, reconnecting with backoff, and forwards each announcement.
async fn watch(url: Url, contract: Address, wakes: mpsc::Sender<Wake>, live: Arc<AtomicBool>) {
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
                    if wakes.send(Wake::Resync).await.is_err() {
                        return;
                    }
                    let mut logs = subscription.into_stream();
                    while let Some(log) = logs.next().await {
                        let (Some(block), Some(tx), Some(index)) =
                            (log.block_number, log.transaction_hash, log.log_index)
                        else {
                            continue;
                        };
                        if wakes
                            .send(Wake::Log(Announced { block, tx, index }))
                            .await
                            .is_err()
                        {
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

async fn tick(state: &AppState, cursor: u64) -> Result<(u64, Pass)> {
    // Behind a load balancer, the node answering `eth_getLogs` may be a block behind the one
    // that reported the head, and an empty answer for that block would never be revisited.
    let head = state
        .chain
        .provider
        .get_block_number()
        .await
        .context("block number")?
        .saturating_sub(1);
    if head <= cursor {
        return Ok((cursor, Pass::Done));
    }
    let to = head.min(cursor + MAX_RANGE);
    let logs = get_logs(state, cursor + 1, to).await?;
    commit(state, &logs, to).await?;
    Ok((to, if to == head { Pass::Done } else { Pass::More }))
}

/// Reads up to the newest announced block. The announcement proves those blocks exist, so no head
/// lookup is needed, but every announced log must be in the answer before the cursor moves.
async fn catch_up(state: &AppState, cursor: u64, announced: &[Announced]) -> Result<(u64, Pass)> {
    let Some(target) = announced
        .iter()
        .map(|log| log.block)
        .max()
        .filter(|&b| b > cursor)
    else {
        return Ok((cursor, Pass::Done));
    };
    let to = target.min(cursor + MAX_RANGE);
    let logs = get_logs(state, cursor + 1, to).await?;
    let present = |a: &Announced| {
        logs.iter()
            .any(|log| log.transaction_hash == Some(a.tx) && log.log_index == Some(a.index))
    };
    if announced.iter().any(|a| a.block <= to && !present(a)) {
        return Ok((cursor, Pass::Lagging));
    }
    commit(state, &logs, to).await?;
    Ok((to, if to == target { Pass::Done } else { Pass::More }))
}

async fn get_logs(state: &AppState, from: u64, to: u64) -> Result<Vec<Log>> {
    let filter = Filter::new()
        .address(state.chain.contract)
        .from_block(from)
        .to_block(to);
    state
        .chain
        .provider
        .get_logs(&filter)
        .await
        .context("get logs")
}

/// Applies the logs and moves the cursor to `to` in one transaction, then announces the events.
async fn commit(state: &AppState, logs: &[Log], to: u64) -> Result<()> {
    let mut tx = state.db.begin().await?;
    let events = apply_logs(&mut tx, &state.chain, logs).await?;
    sqlx::query(
        "insert into indexer_state (id, last_block) values (true, $1)
         on conflict (id) do update set last_block = excluded.last_block",
    )
    .bind(to as i64)
    .execute(&mut *tx)
    .await?;
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
    use crate::{chain::IPushPot, testing};

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

    /// A log from our contract that the indexer doesn't act on, standing in for any event.
    fn announced_log(block: u64, index: u64) -> (Log, Announced) {
        let tx = B256::repeat_byte(0x11);
        let log = Log {
            inner: PrimitiveLog {
                address: Address::ZERO,
                data: LogData::new_unchecked(vec![B256::repeat_byte(0x99)], Bytes::new()),
            },
            block_number: Some(block),
            transaction_hash: Some(tx),
            log_index: Some(index),
            ..Default::default()
        };
        (log, Announced { block, tx, index })
    }

    async fn stored_cursor(db: &PgPool) -> Option<i64> {
        sqlx::query_scalar("select last_block from indexer_state")
            .fetch_optional(db)
            .await
            .unwrap()
    }

    #[sqlx::test]
    async fn an_announcement_is_indexed_with_one_query(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let (log, announced) = announced_log(12, 0);

        rpc.push_success(&vec![log]);
        assert_eq!(
            catch_up(&state, 5, &[announced]).await.unwrap(),
            (12, Pass::Done)
        );
        assert!(rpc.read_q().is_empty(), "no head lookup needed");
        assert_eq!(stored_cursor(&db).await, Some(12));
    }

    #[sqlx::test]
    async fn a_lagging_node_never_moves_the_cursor_past_an_announcement(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let (_, announced) = announced_log(12, 3);

        rpc.push_success(&Vec::<Log>::new());
        assert_eq!(
            catch_up(&state, 5, &[announced]).await.unwrap(),
            (5, Pass::Lagging)
        );
        assert_eq!(stored_cursor(&db).await, None);
    }

    #[sqlx::test]
    async fn announcements_already_indexed_cost_nothing(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let (_, announced) = announced_log(12, 0);

        assert_eq!(
            catch_up(&state, 12, &[announced]).await.unwrap(),
            (12, Pass::Done)
        );
        assert!(rpc.read_q().is_empty());
    }

    #[sqlx::test]
    async fn a_burst_of_announcements_is_read_together(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let (first, a) = announced_log(12, 0);
        let (second, b) = announced_log(15, 1);

        rpc.push_success(&vec![first, second]);
        assert_eq!(
            catch_up(&state, 5, &[a, b]).await.unwrap(),
            (15, Pass::Done)
        );
        assert_eq!(stored_cursor(&db).await, Some(15));
    }

    #[sqlx::test]
    async fn indexes_up_to_the_block_before_the_head(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());

        rpc.push_success(&"0xa");
        rpc.push_success(&Vec::<Log>::new());
        assert_eq!(tick(&state, 5).await.unwrap(), (9, Pass::Done));
        let cursor: i64 = sqlx::query_scalar("select last_block from indexer_state")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(cursor, 9);

        rpc.push_success(&"0xa");
        assert_eq!(tick(&state, 9).await.unwrap(), (9, Pass::Done));
        assert!(rpc.read_q().is_empty());
    }
}
