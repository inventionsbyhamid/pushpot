//! Official challenges: a fixed catalog of templates that the server opens on a schedule from the
//! curator key (the oracle key in deployment), so there is always a cohort anyone can join.

use std::{iter::successors, sync::atomic::Ordering, time::Duration};

use alloy::{
    primitives::{Address, B256},
    providers::Provider,
    rpc::types::Filter,
    sol_types::SolEvent,
};
use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, NaiveDate, NaiveTime, TimeDelta, Utc, Weekday};
use serde::Serialize;
use sqlx::PgPool;

use crate::{
    chain::{
        IPushPot::{self, PotParams},
        indexer::MAX_RANGE,
        oracle::OracleError,
        redact_url,
    },
    state::AppState,
};

const INTERVAL: Duration = Duration::from_secs(30 * 60);
/// Too close to the start for anyone to find and join.
const MIN_LEAD: TimeDelta = TimeDelta::hours(1);
/// Mirrors `PushPot.MAX_START_DELAY`.
const MAX_LEAD: TimeDelta = TimeDelta::days(30);
const USDC: u128 = 1_000_000;
const DAY: u32 = 86_400;
const WEEK: u32 = 7 * DAY;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cadence {
    Daily,
    Weekly,
    Weekend,
    Monthly,
    Yearly,
}

impl Cadence {
    /// How many upcoming instances to keep open.
    fn ahead(self) -> usize {
        match self {
            Self::Daily | Self::Weekly | Self::Weekend => 2,
            Self::Monthly | Self::Yearly => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Rookie,
    Regular,
    Beast,
}

/// The days an instance starts on, always at 00:00 UTC.
#[derive(Debug, Clone, Copy)]
enum Starts {
    EveryDay,
    Every(Weekday),
    FirstOfMonth,
    FirstInMonth(Weekday),
}

impl Starts {
    fn on(self, date: NaiveDate) -> bool {
        match self {
            Self::EveryDay => true,
            Self::Every(weekday) => date.weekday() == weekday,
            Self::FirstOfMonth => date.day() == 1,
            Self::FirstInMonth(weekday) => date.weekday() == weekday && date.day() <= 7,
        }
    }

    /// The first start strictly after `after`.
    fn next(self, after: DateTime<Utc>) -> DateTime<Utc> {
        after
            .date_naive()
            .iter_days()
            .filter(|&date| self.on(date))
            .map(|date| date.and_time(NaiveTime::MIN).and_utc())
            .find(|&start| start > after)
            .expect("every schedule recurs")
    }
}

#[derive(Debug, Clone, Copy)]
enum Length {
    Periods(u16),
    DaysInMonth,
}

#[derive(Debug)]
pub struct Template {
    pub key: &'static str,
    pub cadence: Cadence,
    pub name: &'static str,
    pub tier: Tier,
    pub tagline: &'static str,
    /// Starts each instance's title, before its date.
    label: &'static str,
    starts: Starts,
    reps: u16,
    length: Length,
    period_seconds: u32,
    /// In USDC base units.
    stake: u128,
    max_members: u16,
}

pub const CATALOG: &[Template] = &[
    Template {
        key: "daily-20",
        cadence: Cadence::Daily,
        name: "Daily 20",
        tier: Tier::Rookie,
        tagline: "Twenty pushups. One day. No excuses.",
        label: "Daily 20",
        starts: Starts::EveryDay,
        reps: 20,
        length: Length::Periods(1),
        period_seconds: DAY,
        stake: USDC,
        max_members: 1_000,
    },
    Template {
        key: "daily-50",
        cadence: Cadence::Daily,
        name: "Daily 50",
        tier: Tier::Regular,
        tagline: "Fifty before midnight, or your stake says otherwise.",
        label: "Daily 50",
        starts: Starts::EveryDay,
        reps: 50,
        length: Length::Periods(1),
        period_seconds: DAY,
        stake: 2 * USDC,
        max_members: 1_000,
    },
    Template {
        key: "daily-100",
        cadence: Cadence::Daily,
        name: "Daily 100",
        tier: Tier::Beast,
        tagline: "A hundred reps in a day. Big stake, bigger bragging rights.",
        label: "Daily 100",
        starts: Starts::EveryDay,
        reps: 100,
        length: Length::Periods(1),
        period_seconds: DAY,
        stake: 5 * USDC,
        max_members: 1_000,
    },
    Template {
        key: "kickoff",
        cadence: Cadence::Weekly,
        name: "Monday Kickoff",
        tier: Tier::Rookie,
        tagline: "Twenty a day, Monday to Sunday. Start the week moving.",
        label: "Monday Kickoff",
        starts: Starts::Every(Weekday::Mon),
        reps: 20,
        length: Length::Periods(7),
        period_seconds: DAY,
        stake: 3 * USDC,
        max_members: 1_000,
    },
    Template {
        key: "iron-week",
        cadence: Cadence::Weekly,
        name: "Iron Week",
        tier: Tier::Beast,
        tagline: "Fifty a day for seven days. Skip one and you feed the pot.",
        label: "Iron Week",
        starts: Starts::Every(Weekday::Mon),
        reps: 50,
        length: Length::Periods(7),
        period_seconds: DAY,
        stake: 5 * USDC,
        max_members: 1_000,
    },
    Template {
        key: "weekend-warrior",
        cadence: Cadence::Weekend,
        name: "Weekend Warrior",
        tier: Tier::Regular,
        tagline: "Fifty on Saturday, fifty on Sunday. Earn your weekend.",
        label: "Weekend Warrior",
        starts: Starts::Every(Weekday::Sat),
        reps: 50,
        length: Length::Periods(2),
        period_seconds: DAY,
        stake: 2 * USDC,
        max_members: 1_000,
    },
    Template {
        key: "thirty-day",
        cadence: Cadence::Monthly,
        name: "30 Day Challenge",
        tier: Tier::Regular,
        tagline: "25 a day, every day this month. Habit, built.",
        label: "30 Day",
        starts: Starts::FirstOfMonth,
        reps: 25,
        length: Length::DaysInMonth,
        period_seconds: DAY,
        stake: 5 * USDC,
        max_members: 1_000,
    },
    Template {
        key: "club-52",
        cadence: Cadence::Yearly,
        name: "52 Week Club",
        tier: Tier::Beast,
        tagline: "A hundred pushups a week for a year. Only the stubborn get paid.",
        label: "52 Week Club",
        starts: Starts::FirstInMonth(Weekday::Mon),
        reps: 100,
        length: Length::Periods(52),
        period_seconds: WEEK,
        stake: 10 * USDC,
        max_members: 1_000,
    },
];

pub fn template(key: &str) -> Option<&'static Template> {
    CATALOG.iter().find(|template| template.key == key)
}

impl Template {
    /// The starts that should already be open at `now`: the next few, if the contract accepts
    /// them and there's time left for people to join.
    fn upcoming(&self, now: DateTime<Utc>) -> Vec<DateTime<Utc>> {
        successors(Some(self.starts.next(now)), |&start| {
            Some(self.starts.next(start))
        })
        .take(self.cadence.ahead())
        .filter(|&start| start > now + MIN_LEAD && start < now + MAX_LEAD)
        .collect()
    }

    fn title(&self, start: DateTime<Utc>) -> String {
        let date = match self.cadence {
            Cadence::Daily | Cadence::Weekly | Cadence::Weekend => start.format("%b %-d"),
            Cadence::Monthly => start.format("%B"),
            Cadence::Yearly => start.format("%b %Y"),
        };
        format!("{} · {date}", self.label)
    }

    fn periods(&self, start: DateTime<Utc>) -> u16 {
        match self.length {
            Length::Periods(periods) => periods,
            Length::DaysInMonth => {
                let first = start.date_naive().with_day(1).expect("day 1 exists");
                let next = first + chrono::Months::new(1);
                (next - first).num_days() as u16
            }
        }
    }

    fn params(&self, start: DateTime<Utc>) -> PotParams {
        PotParams {
            title: self.title(start),
            stake: self.stake,
            repsPerPeriod: self.reps,
            periods: self.periods(start),
            periodSeconds: self.period_seconds,
            startTime: start.timestamp() as u64,
            maxMembers: self.max_members,
        }
    }
}

/// How soon to try again when the indexer hasn't caught up yet or a pass failed.
const RETRY: Duration = Duration::from_secs(15);

pub async fn run(state: AppState) {
    // `maxStake` is immutable, so it's read from the contract once.
    let mut max_stake = None;
    loop {
        let wait = match curate(&state, Utc::now(), &mut max_stake).await {
            Ok(true) => INTERVAL,
            Ok(false) => RETRY,
            Err(err) => {
                let error = redact_url(&format!("{err:#}"), &state.config.rpc_url);
                tracing::warn!(%error, "opening challenges failed");
                RETRY
            }
        };
        tokio::time::sleep(wait).await;
    }
}

/// Returns false when it couldn't run yet and should be retried soon. Makes no RPC calls unless an
/// instance is missing or stuck.
async fn curate(
    state: &AppState,
    now: DateTime<Utc>,
    max_stake: &mut Option<u128>,
) -> Result<bool> {
    // On a fresh or restored database the indexer must see existing challenges first, or they'd
    // be opened a second time.
    if !state.indexer_ready.load(Ordering::Relaxed) {
        tracing::info!("waiting for the indexer to catch up before opening challenges");
        return Ok(false);
    }
    if !has_work(state, now).await? {
        return Ok(true);
    }
    let ours = state.config.oracle_signer.address();
    let curator = state.chain.curator().await.context("reading curator")?;
    if curator != ours {
        tracing::warn!(%curator, oracle = %ours, "the oracle key isn't the curator; not opening challenges");
        return Ok(true);
    }
    let max_stake = match *max_stake {
        Some(cached) => cached,
        None => *max_stake.insert(state.chain.max_stake().await.context("reading max stake")?),
    };
    let head = state
        .chain
        .provider
        .get_block_number()
        .await
        .context("block number")?;

    reconcile(state, ours, head).await?;
    open_missing(state, now, max_stake, head).await?;
    Ok(true)
}

/// Whether any upcoming instance is missing (after adopting ones already on chain) or a pending
/// one needs reconciling. Database only.
async fn has_work(state: &AppState, now: DateTime<Utc>) -> Result<bool> {
    let stuck: bool = sqlx::query_scalar(
        "select exists(select 1 from challenges
         where state = 'pending' and created_at < now() - interval '2 minutes')",
    )
    .fetch_one(&state.db)
    .await?;
    if stuck {
        return Ok(true);
    }
    for template in CATALOG {
        for start in template.upcoming(now) {
            if !adopt_existing(&state.db, template, start, &template.title(start)).await? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Opens every upcoming instance that doesn't exist yet. `head` is a block no new transaction can
/// land at or before, which is where `reconcile` starts looking.
pub async fn open_missing(
    state: &AppState,
    now: DateTime<Utc>,
    max_stake: u128,
    head: u64,
) -> Result<()> {
    for template in CATALOG {
        if template.stake > max_stake {
            tracing::warn!(
                template = template.key,
                stake = template.stake,
                max_stake,
                "challenge stake is above the contract's limit; skipping it"
            );
            continue;
        }
        for start in template.upcoming(now) {
            open(state, template, start, head).await?;
        }
    }
    Ok(())
}

/// Opens one instance unless it's already open or underway. The row is claimed as 'pending'
/// before anything is sent, so a crash or restart leaves a row for `reconcile` rather than a
/// second pot.
async fn open(
    state: &AppState,
    template: &Template,
    start: DateTime<Utc>,
    head: u64,
) -> Result<()> {
    let params = template.params(start);
    if adopt_existing(&state.db, template, start, &params.title).await? {
        return Ok(());
    }
    let claimed = sqlx::query(
        "insert into challenges (template_key, start_time, title, from_block)
         values ($1, $2, $3, $4)
         on conflict (template_key, start_time) do nothing",
    )
    .bind(template.key)
    .bind(start)
    .bind(&params.title)
    .bind(head as i64)
    .execute(&state.db)
    .await?;
    if claimed.rows_affected() == 0 {
        return Ok(());
    }

    let title = params.title.clone();
    match state.oracle.create_challenge(params).await {
        Ok(created) => {
            mark_created(
                &state.db,
                template.key,
                start,
                created.pot_id,
                created.tx_hash,
            )
            .await?;
        }
        // Nothing was created, so free the slot for the next pass.
        Err(OracleError::Rejected(reason)) => {
            tracing::error!(template = template.key, %title, %reason, "challenge refused");
            release(&state.db, template.key, start).await?;
        }
        // It may still land; `reconcile` finds out once the dust has settled.
        Err(err) => {
            tracing::warn!(template = template.key, %title, error = %err, "challenge unconfirmed");
        }
    }
    Ok(())
}

/// Settles instances left 'pending' by a crash or an unconfirmed transaction: 'created' if the
/// curator's `PotCreated` for it is on chain, otherwise released so the next pass opens it again.
/// Only rows older than any oracle job can run are touched.
pub async fn reconcile(state: &AppState, curator: Address, head: u64) -> Result<()> {
    let stuck: Vec<(String, DateTime<Utc>, String, i64)> = sqlx::query_as(
        "select template_key, start_time, title, from_block from challenges
         where state = 'pending' and created_at < now() - interval '2 minutes'",
    )
    .fetch_all(&state.db)
    .await?;
    let Some(from) = stuck.iter().map(|row| row.3 as u64).min() else {
        return Ok(());
    };

    let created = created_by(state, curator, from, head.saturating_sub(1)).await?;
    for (key, start, title, _) in stuck {
        let landed = created
            .iter()
            .find(|pot| pot.title == title && pot.start_time == start.timestamp() as u64);
        match landed {
            Some(pot) => {
                tracing::info!(template = %key, %title, pot_id = pot.pot_id, "recovered challenge");
                mark_created(&state.db, &key, start, pot.pot_id, pot.tx_hash).await?;
            }
            None => {
                tracing::warn!(template = %key, %title, "challenge never landed; retrying");
                release(&state.db, &key, start).await?;
            }
        }
    }
    Ok(())
}

struct CreatedPot {
    pot_id: u64,
    title: String,
    start_time: u64,
    tx_hash: B256,
}

/// Every pot `creator` opened between the two blocks.
async fn created_by(
    state: &AppState,
    creator: Address,
    from: u64,
    to: u64,
) -> Result<Vec<CreatedPot>> {
    let mut pots = Vec::new();
    let mut start = from;
    while start <= to {
        let end = to.min(start + MAX_RANGE - 1);
        let filter = Filter::new()
            .address(state.chain.contract)
            .event_signature(IPushPot::PotCreated::SIGNATURE_HASH)
            .topic2(creator.into_word())
            .from_block(start)
            .to_block(end);
        let logs = state
            .chain
            .provider
            .get_logs(&filter)
            .await
            .context("get logs")?;
        for log in logs {
            let Ok(created) = log.log_decode::<IPushPot::PotCreated>() else {
                continue;
            };
            let event = created.inner.data;
            pots.push(CreatedPot {
                pot_id: u64::try_from(event.potId).context("pot id")?,
                title: event.title,
                start_time: event.startTime,
                tx_hash: log.transaction_hash.unwrap_or_default(),
            });
        }
        start = end + 1;
    }
    Ok(pots)
}

/// Records an instance that is already on chain, for example one opened before the database was
/// restored, instead of opening it again.
async fn adopt_existing(
    db: &PgPool,
    template: &Template,
    start: DateTime<Utc>,
    title: &str,
) -> Result<bool> {
    let adopted = sqlx::query(
        "insert into challenges (template_key, start_time, title, from_block, state, pot_id, created_tx)
         select $1, $2, $3, p.created_block, 'created', p.id, p.created_tx
         from pots p where p.official and p.title = $3 and p.start_time = $2
         order by p.id limit 1
         on conflict (template_key, start_time) do nothing",
    )
    .bind(template.key)
    .bind(start)
    .bind(title)
    .execute(db)
    .await?;
    if adopted.rows_affected() > 0 {
        return Ok(true);
    }
    let known: bool = sqlx::query_scalar(
        "select exists(select 1 from challenges where template_key = $1 and start_time = $2)",
    )
    .bind(template.key)
    .bind(start)
    .fetch_one(db)
    .await?;
    Ok(known)
}

async fn mark_created(
    db: &PgPool,
    key: &str,
    start: DateTime<Utc>,
    pot_id: u64,
    tx_hash: B256,
) -> Result<()> {
    sqlx::query(
        "update challenges set state = 'created', pot_id = $3, created_tx = $4
         where template_key = $1 and start_time = $2",
    )
    .bind(key)
    .bind(start)
    .bind(pot_id as i64)
    .bind(format!("{tx_hash:#x}"))
    .execute(db)
    .await?;
    Ok(())
}

async fn release(db: &PgPool, key: &str, start: DateTime<Utc>) -> Result<()> {
    sqlx::query(
        "delete from challenges where template_key = $1 and start_time = $2 and state = 'pending'",
    )
    .bind(key)
    .bind(start)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use alloy::{
        primitives::{Log as PrimitiveLog, U256},
        rpc::types::Log,
    };

    use super::*;
    use crate::testing::{self, FIRST_CHALLENGE_ID, FakeOracle, Outcome};

    fn at(rfc3339: &str) -> DateTime<Utc> {
        rfc3339.parse().unwrap()
    }

    fn template(key: &str) -> &'static Template {
        super::template(key).unwrap()
    }

    /// A Tuesday afternoon.
    fn now() -> DateTime<Utc> {
        at("2026-10-13T12:00:00Z")
    }

    #[test]
    fn starts_follow_each_schedule() {
        let upcoming = |key| template(key).upcoming(now());
        assert_eq!(
            upcoming("daily-20"),
            [at("2026-10-14T00:00:00Z"), at("2026-10-15T00:00:00Z")]
        );
        assert_eq!(
            upcoming("kickoff"),
            [at("2026-10-19T00:00:00Z"), at("2026-10-26T00:00:00Z")]
        );
        assert_eq!(
            upcoming("weekend-warrior"),
            [at("2026-10-17T00:00:00Z"), at("2026-10-24T00:00:00Z")]
        );
        assert_eq!(upcoming("thirty-day"), [at("2026-11-01T00:00:00Z")]);
        assert_eq!(upcoming("club-52"), [at("2026-11-02T00:00:00Z")]);
    }

    #[test]
    fn starts_leave_time_to_join_and_respect_the_start_limit() {
        let late = at("2026-10-31T23:30:00Z");
        assert_eq!(
            template("daily-20").upcoming(late),
            [at("2026-11-02T00:00:00Z")]
        );
        assert!(template("thirty-day").upcoming(late).is_empty());

        // November 1st is just over 30 days away, then just under.
        let thirty_day = template("thirty-day");
        assert!(thirty_day.upcoming(at("2026-10-01T00:30:00Z")).is_empty());
        assert_eq!(
            thirty_day.upcoming(at("2026-10-02T00:30:00Z")),
            [at("2026-11-01T00:00:00Z")]
        );
    }

    #[test]
    fn titles_and_lengths_read_well() {
        let title = |key, start| template(key).title(at(start));
        assert_eq!(
            title("daily-50", "2026-10-14T00:00:00Z"),
            "Daily 50 · Oct 14"
        );
        assert_eq!(
            title("iron-week", "2026-10-19T00:00:00Z"),
            "Iron Week · Oct 19"
        );
        assert_eq!(
            title("thirty-day", "2026-11-01T00:00:00Z"),
            "30 Day · November"
        );
        assert_eq!(
            title("club-52", "2026-11-02T00:00:00Z"),
            "52 Week Club · Nov 2026"
        );

        let days = |start| template("thirty-day").periods(at(start));
        assert_eq!(days("2026-11-01T00:00:00Z"), 30);
        assert_eq!(days("2026-12-01T00:00:00Z"), 31);
        assert_eq!(days("2027-02-01T00:00:00Z"), 28);
        assert_eq!(days("2028-02-01T00:00:00Z"), 29);
    }

    #[test]
    fn every_instance_fits_the_contract() {
        let mut day = now();
        for _ in 0..400 {
            for template in CATALOG {
                for start in template.upcoming(day) {
                    let params = template.params(start);
                    assert!(params.title.len() <= 48, "{}", params.title);
                    assert!(params.title.bytes().all(|b| b >= 0x20 && b != 0x7f));
                    assert!((1..=90).contains(&params.periods));
                    assert!((600..=WEEK).contains(&params.periodSeconds));
                    assert!((1..=1_000).contains(&params.repsPerPeriod));
                    assert!(params.stake >= USDC);
                    assert!(params.maxMembers <= 1_000);
                }
            }
            day += TimeDelta::days(1);
        }
    }

    async fn rows(db: &PgPool) -> Vec<(String, String, Option<i64>)> {
        sqlx::query_as(
            "select template_key, state, pot_id from challenges order by template_key, start_time",
        )
        .fetch_all(db)
        .await
        .unwrap()
    }

    #[sqlx::test]
    async fn adopts_challenges_already_on_chain(db: PgPool) {
        let daily = template("daily-20");
        let start = daily.upcoming(now())[0];
        sqlx::query(
            "insert into pots (id, creator, title, stake, reps_per_period, periods, period_seconds,
                 start_time, max_members, created_tx, created_block, official)
             values (77, '0xcurator', $1, 1000000, 20, 1, 86400, $2, 1000, '0xabc', 5, true)",
        )
        .bind(daily.title(start))
        .bind(start)
        .execute(&db)
        .await
        .unwrap();
        let oracle = Arc::new(FakeOracle::default());
        let (state, _) = testing::state(db.clone(), oracle.clone());

        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();

        assert_eq!(oracle.challenge_titles().len(), 13);
        assert!(!oracle.challenge_titles().contains(&daily.title(start)));
        let adopted: (String, Option<i64>) = sqlx::query_as(
            "select state, pot_id from challenges where template_key = 'daily-20' and start_time = $1",
        )
        .bind(start)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(adopted, ("created".to_owned(), Some(77)));
    }

    #[sqlx::test]
    async fn makes_no_rpc_calls_when_every_challenge_is_open(db: PgPool) {
        let oracle = Arc::new(FakeOracle::default());
        let (state, rpc) = testing::state(db, oracle.clone());
        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();
        let opened = oracle.challenge_titles().len();

        // No responses are queued, so any RPC call would fail the pass.
        assert!(curate(&state, now(), &mut None).await.unwrap());
        assert_eq!(oracle.challenge_titles().len(), opened);
        assert!(rpc.read_q().is_empty());
    }

    #[sqlx::test]
    async fn waits_for_the_indexer_before_opening_anything(db: PgPool) {
        let oracle = Arc::new(FakeOracle::default());
        let (state, rpc) = testing::state(db, oracle.clone());
        state.indexer_ready.store(false, Ordering::Relaxed);

        assert!(!curate(&state, now(), &mut None).await.unwrap());
        assert!(oracle.challenge_titles().is_empty());
        assert!(rpc.read_q().is_empty(), "no RPC calls while waiting");
    }

    #[sqlx::test]
    async fn opens_every_upcoming_challenge_once(db: PgPool) {
        let oracle = Arc::new(FakeOracle::default());
        let (state, _) = testing::state(db.clone(), oracle.clone());

        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();
        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();

        // 3 daily × 2, 2 weekly × 2, 1 weekend × 2, 1 monthly, 1 yearly.
        let titles = oracle.challenge_titles();
        assert_eq!(titles.len(), 14);
        assert!(titles.contains(&"Daily 100 · Oct 15".to_owned()));
        assert!(titles.contains(&"Weekend Warrior · Oct 24".to_owned()));
        let rows = rows(&db).await;
        assert_eq!(rows.len(), 14);
        assert!(
            rows.iter()
                .all(|(_, state, pot)| state == "created" && pot.is_some())
        );
        assert!(
            rows.iter()
                .any(|(_, _, pot)| *pot == Some(FIRST_CHALLENGE_ID as i64))
        );
    }

    #[sqlx::test]
    async fn skips_stakes_above_the_contract_limit(db: PgPool) {
        let oracle = Arc::new(FakeOracle::default());
        let (state, _) = testing::state(db.clone(), oracle.clone());

        open_missing(&state, now(), 4 * USDC, 100).await.unwrap();

        let opened: Vec<String> = rows(&db).await.into_iter().map(|row| row.0).collect();
        assert_eq!(opened.len(), 8);
        for key in ["daily-100", "iron-week", "thirty-day", "club-52"] {
            assert!(!opened.iter().any(|k| k == key), "{key}");
        }
    }

    #[sqlx::test]
    async fn an_unconfirmed_challenge_is_never_sent_twice(db: PgPool) {
        let oracle = Arc::new(FakeOracle::default());
        *oracle.challenge_outcome.lock().unwrap() = Outcome::Lost;
        let (state, _) = testing::state(db.clone(), oracle.clone());

        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();
        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();

        assert_eq!(oracle.challenge_titles().len(), 14);
        assert!(
            rows(&db)
                .await
                .iter()
                .all(|(_, state, _)| state == "pending")
        );
    }

    #[sqlx::test]
    async fn a_refused_challenge_is_tried_again(db: PgPool) {
        let oracle = Arc::new(FakeOracle::default());
        *oracle.challenge_outcome.lock().unwrap() = Outcome::Refused;
        let (state, _) = testing::state(db.clone(), oracle.clone());

        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();
        assert!(rows(&db).await.is_empty());

        *oracle.challenge_outcome.lock().unwrap() = Outcome::Confirmed;
        open_missing(&state, now(), 20 * USDC, 100).await.unwrap();
        assert_eq!(oracle.challenge_titles().len(), 28);
        assert_eq!(rows(&db).await.len(), 14);
    }

    #[sqlx::test]
    async fn reconcile_recovers_landed_challenges_and_releases_lost_ones(db: PgPool) {
        let (state, rpc) = testing::state(db.clone(), Arc::default());
        let curator = Address::repeat_byte(0xc0);
        let start = at("2026-10-14T00:00:00Z");
        for (key, title, age) in [
            ("daily-20", "Daily 20 · Oct 14", "5 minutes"),
            ("daily-50", "Daily 50 · Oct 14", "5 minutes"),
            ("daily-100", "Daily 100 · Oct 14", "0 minutes"),
        ] {
            sqlx::query(
                "insert into challenges (template_key, start_time, title, from_block, created_at)
                 values ($1, $2, $3, 100, now() - $4::interval)",
            )
            .bind(key)
            .bind(start)
            .bind(title)
            .bind(age)
            .execute(&db)
            .await
            .unwrap();
        }

        let landed = template("daily-20").params(start);
        let log = Log {
            inner: PrimitiveLog {
                address: state.chain.contract,
                data: IPushPot::PotCreated {
                    potId: U256::from(77),
                    creator: curator,
                    title: landed.title,
                    stake: landed.stake,
                    repsPerPeriod: landed.repsPerPeriod,
                    periods: landed.periods,
                    periodSeconds: landed.periodSeconds,
                    startTime: landed.startTime,
                    maxMembers: landed.maxMembers,
                }
                .encode_log_data(),
            },
            block_number: Some(150),
            transaction_hash: Some(B256::repeat_byte(0x77)),
            ..Default::default()
        };
        rpc.push_success(&vec![log]);

        reconcile(&state, curator, 512).await.unwrap();

        assert!(rpc.read_q().is_empty());
        assert_eq!(
            rows(&db).await,
            [
                ("daily-100".to_owned(), "pending".to_owned(), None),
                ("daily-20".to_owned(), "created".to_owned(), Some(77)),
            ]
        );
    }
}
