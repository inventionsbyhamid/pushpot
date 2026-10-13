-- Official challenges are flagged by `ChallengeCreated`. The fee isn't in `PotCreated`, so the
-- indexer reads it with `getPot`.
alter table pots add column official boolean not null default false;
alter table pots add column fee_bps integer not null default 0;
-- Null until settled: the amount from `FeeCollected`, or 0 once there was nothing to collect.
alter table pots add column fee_amount bigint;
alter table pots add column fee_tx text;
create index pots_fee_due_idx on pots (start_time) where fee_amount is null and fee_bps > 0;

-- Instances the scheduler opened. A row is claimed as 'pending' before `createChallenge` is sent,
-- so a crash can't open the same instance twice; `from_block` is where to look for its
-- `PotCreated` if the outcome is unknown.
create table challenges (
    template_key text not null,
    start_time   timestamptz not null,
    title        text not null,
    state        text not null default 'pending' check (state in ('pending', 'created')),
    from_block   bigint not null,
    pot_id       bigint unique,
    created_tx   text,
    created_at   timestamptz not null default now(),
    primary key (template_key, start_time),
    check ((state = 'created') = (pot_id is not null))
);
