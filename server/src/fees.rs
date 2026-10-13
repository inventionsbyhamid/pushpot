//! Sends finished pots' fees to the treasury. `collectFee` is open to anyone and only ever pays the
//! treasury, so the server simply makes sure it happens.

use std::time::Duration;

use anyhow::{Context, Result};
use sqlx::PgPool;

use crate::{chain::redact_url, pots::GRACE, state::AppState};

const INTERVAL: Duration = Duration::from_secs(30 * 60);
const BATCH: i64 = 20;

pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(INTERVAL);
    loop {
        interval.tick().await;
        if let Err(err) = collect_due(&state).await {
            let error = redact_url(&format!("{err:#}"), &state.config.rpc_url);
            tracing::warn!(%error, "fee collection failed");
        }
    }
}

/// Collects the fee of each pot that has stopped accepting check-ins and has no fee on record.
/// The contract's `collectableFee` decides; a pot with nothing to collect is settled at 0.
pub async fn collect_due(state: &AppState) -> Result<()> {
    let due: Vec<i64> = sqlx::query_scalar(
        "select id from pots
         where fee_amount is null and fee_bps > 0
           and start_time + (periods * period_seconds + $1) * interval '1 second' <= now()
         order by start_time
         limit $2",
    )
    .bind(GRACE.num_seconds() as i32)
    .bind(BATCH)
    .fetch_all(&state.db)
    .await?;

    for pot_id in due {
        let collectable = state
            .chain
            .collectable_fee(pot_id as u64)
            .await
            .context("reading collectable fee")?;
        if collectable.is_zero() {
            settle(&state.db, pot_id, 0, None).await?;
            continue;
        }
        match state.oracle.collect_fee(pot_id as u64).await {
            Ok(collected) => {
                let amount = i64::try_from(collected.amount).context("fee amount")?;
                let tx_hash = format!("{:#x}", collected.tx_hash);
                settle(&state.db, pot_id, amount, Some(&tx_hash)).await?;
            }
            Err(err) => tracing::warn!(pot_id, error = %err, "couldn't collect fee"),
        }
    }
    Ok(())
}

/// Records the outcome unless the indexer already has the `FeeCollected` event.
async fn settle(db: &PgPool, pot_id: i64, amount: i64, tx_hash: Option<&str>) -> Result<()> {
    sqlx::query(
        "update pots set fee_amount = $2, fee_tx = $3 where id = $1 and fee_amount is null",
    )
    .bind(pot_id)
    .bind(amount)
    .bind(tx_hash)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use alloy::{
        primitives::{Bytes, U256},
        sol_types::SolValue,
    };

    use super::*;
    use crate::testing::{self, COLLECTED_FEE, FakeOracle};

    async fn pot(db: &PgPool, id: i64, started: &str, fee_bps: i32, fee_amount: Option<i64>) {
        sqlx::query(
            "insert into pots (id, creator, title, stake, reps_per_period, periods, period_seconds,
                 start_time, max_members, created_tx, created_block, fee_bps, fee_amount)
             values ($1, '0xa', 'Sprint', 5000000, 10, 3, 600, now() - $2::interval, 10, '0x', 1,
                 $3, $4)",
        )
        .bind(id)
        .bind(started)
        .bind(fee_bps)
        .bind(fee_amount)
        .execute(db)
        .await
        .unwrap();
    }

    fn word(value: u64) -> Bytes {
        U256::from(value).abi_encode().into()
    }

    #[sqlx::test]
    async fn collects_only_from_finished_pots_that_owe_a_fee(db: PgPool) {
        pot(&db, 1, "2 days", 500, None).await;
        pot(&db, 2, "1 day", 500, None).await;
        pot(&db, 3, "1 minute", 500, None).await;
        pot(&db, 4, "1 day", 0, None).await;
        pot(&db, 5, "1 day", 500, Some(99)).await;
        // The grace period after the last period hasn't passed yet.
        pot(&db, 6, "32 minutes", 500, None).await;
        let oracle = Arc::new(FakeOracle::default());
        let (state, rpc) = testing::state(db.clone(), oracle.clone());

        rpc.push_success(&word(0));
        rpc.push_success(&word(COLLECTED_FEE));
        collect_due(&state).await.unwrap();
        collect_due(&state).await.unwrap();

        assert!(rpc.read_q().is_empty());
        assert_eq!(*oracle.collected.lock().unwrap(), [2]);
        let fees: Vec<(i64, Option<i64>, Option<String>)> =
            sqlx::query_as("select id, fee_amount, fee_tx from pots order by id")
                .fetch_all(&db)
                .await
                .unwrap();
        let tx = format!("{:#x}", alloy::primitives::B256::repeat_byte(0xfe));
        assert_eq!(
            fees,
            [
                (1, Some(0), None),
                (2, Some(COLLECTED_FEE as i64), Some(tx)),
                (3, None, None),
                (4, None, None),
                (5, Some(99), None),
                (6, None, None),
            ]
        );
    }
}
