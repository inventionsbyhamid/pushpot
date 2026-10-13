//! Mirrors PushPot events into Postgres. It is the only writer for on-chain state: each batch of
//! logs is applied in the same transaction that advances the block cursor, so every log is
//! applied exactly once and in order. Arc has deterministic finality, so there are no reorgs.

use std::time::Duration;

use alloy::{
    primitives::U256,
    providers::Provider,
    rpc::types::{Filter, Log},
    sol_types::SolEventInterface,
};
use anyhow::{Context, Result};
use chrono::DateTime;
use sqlx::{Connection, PgConnection, PgPool};

use super::{IPushPot::IPushPotEvents, redact_url};
use crate::{
    auth::format_address,
    state::{AppState, PotEvent, PotEventKind},
};

/// RPC providers cap `eth_getLogs` at 10,000 blocks per query.
const MAX_RANGE: u64 = 9_999;
/// Consecutive failed ticks (2 s apart) after which the indexer is reported as stuck.
const STUCK_AFTER: u32 = 15;

pub async fn run(state: AppState) {
    let mut cursor = match load_cursor(&state.db, state.chain.deploy_block).await {
        Ok(cursor) => cursor,
        Err(err) => {
            tracing::error!(error = ?err, "indexer could not load its cursor");
            return;
        }
    };
    tracing::info!(cursor, "indexer started");

    let mut failures = 0u32;
    loop {
        match tick(&state, cursor).await {
            Ok((next, caught_up)) => {
                if failures >= STUCK_AFTER {
                    tracing::info!(cursor = next, failures, "indexer recovered");
                }
                failures = 0;
                cursor = next;
                if caught_up {
                    tokio::time::sleep(state.config.indexer_interval).await;
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

async fn load_cursor(db: &PgPool, deploy_block: u64) -> Result<u64> {
    let stored: Option<i64> = sqlx::query_scalar("select last_block from indexer_state")
        .fetch_optional(db)
        .await?;
    Ok(stored.map_or(deploy_block.saturating_sub(1), |b| b as u64))
}

async fn tick(state: &AppState, cursor: u64) -> Result<(u64, bool)> {
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
        return Ok((cursor, true));
    }
    let to = head.min(cursor + MAX_RANGE);
    let filter = Filter::new()
        .address(state.chain.contract)
        .from_block(cursor + 1)
        .to_block(to);
    let logs = state
        .chain
        .provider
        .get_logs(&filter)
        .await
        .context("get logs")?;

    let mut tx = state.db.begin().await?;
    let events = apply_logs(&mut tx, &logs).await?;
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
    Ok((to, to == head))
}

/// Applies a batch of logs and returns the events to broadcast. A log that can never be stored,
/// such as one with data an older deployment let through, is reported and skipped: retrying it
/// forever would stall every join and check-in behind it.
pub async fn apply_logs(db: &mut PgConnection, logs: &[Log]) -> Result<Vec<PotEvent>> {
    let mut events = Vec::new();
    for log in logs {
        let mut savepoint = db.begin().await?;
        match apply(&mut savepoint, log).await {
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
/// else, like a dropped connection, fails the batch so it is retried.
fn is_permanent(err: &anyhow::Error) -> bool {
    match err.downcast_ref::<sqlx::Error>() {
        Some(sqlx::Error::Database(db)) => db
            .code()
            .is_some_and(|code| code.starts_with("22") || code.starts_with("23")),
        Some(_) => false,
        None => true,
    }
}

/// Applies one log and returns the event to broadcast, if any.
async fn apply(db: &mut PgConnection, log: &Log) -> Result<Option<PotEvent>> {
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
            let start = DateTime::from_timestamp(e.startTime as i64, 0).context("start time")?;
            sqlx::query(
                "insert into pots (id, creator, title, stake, reps_per_period, periods,
                     period_seconds, start_time, max_members, created_tx, created_block)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 on conflict (id) do nothing",
            )
            .bind(pot_id(e.potId)?)
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
        primitives::{Address, B256, Log as PrimitiveLog, LogData},
        sol_types::SolEvent,
    };

    use super::*;
    use crate::{chain::IPushPot, testing};

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

        let mut tx = db.begin().await.unwrap();
        let events = apply_logs(&mut tx, &logs).await.unwrap();
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

    #[test]
    fn only_data_errors_are_skipped() {
        assert!(is_permanent(&anyhow::anyhow!("pot id out of range")));
        assert!(!is_permanent(&sqlx::Error::PoolTimedOut.into()));
        assert!(!is_permanent(
            &anyhow::Error::from(sqlx::Error::WorkerCrashed).context("insert")
        ));
    }

    #[sqlx::test]
    async fn indexes_up_to_the_block_before_the_head(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());

        rpc.push_success(&"0xa");
        rpc.push_success(&Vec::<Log>::new());
        assert_eq!(tick(&state, 5).await.unwrap(), (9, true));
        let cursor: i64 = sqlx::query_scalar("select last_block from indexer_state")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(cursor, 9);

        rpc.push_success(&"0xa");
        assert_eq!(tick(&state, 9).await.unwrap(), (9, true));
        assert!(rpc.read_q().is_empty());
    }
}
