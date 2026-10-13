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
use sqlx::{PgConnection, PgPool};

use super::IPushPot::IPushPotEvents;
use crate::{
    auth::format_address,
    state::{AppState, PotEvent, PotEventKind},
};

/// RPC providers cap `eth_getLogs` at 10,000 blocks per query.
const MAX_RANGE: u64 = 9_999;

pub async fn run(state: AppState) {
    let mut cursor = match load_cursor(&state.db, state.chain.deploy_block).await {
        Ok(cursor) => cursor,
        Err(err) => {
            tracing::error!(error = ?err, "indexer could not load its cursor");
            return;
        }
    };
    tracing::info!(cursor, "indexer started");

    loop {
        match tick(&state, cursor).await {
            Ok((next, caught_up)) => {
                cursor = next;
                if caught_up {
                    tokio::time::sleep(state.config.indexer_interval).await;
                }
            }
            Err(err) => {
                tracing::warn!(error = ?err, cursor, "indexer tick failed");
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
    let head = state
        .chain
        .provider
        .get_block_number()
        .await
        .context("block number")?;
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
    let mut events = Vec::new();
    for log in &logs {
        if let Some(event) = apply(&mut tx, log).await? {
            events.push(event);
        }
    }
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

/// Applies one log and returns the event to broadcast, if any.
pub async fn apply(db: &mut PgConnection, log: &Log) -> Result<Option<PotEvent>> {
    let Ok(decoded) = IPushPotEvents::decode_log(&log.inner) else {
        return Ok(None);
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
            .bind(&e.title)
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
