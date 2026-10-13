create table auth_nonces (
    nonce      text primary key,
    created_at timestamptz not null default now()
);

create table sessions (
    token_hash bytea primary key,
    address    text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
);
create index sessions_address_idx on sessions (address);

create table pots (
    id              bigint primary key,
    creator         text not null,
    title           text not null,
    stake           bigint not null,
    reps_per_period integer not null,
    periods         integer not null,
    period_seconds  integer not null,
    start_time      timestamptz not null,
    max_members     integer not null,
    created_tx      text not null,
    created_block   bigint not null
);
create index pots_start_time_idx on pots (start_time);

create table members (
    pot_id         bigint not null references pots (id),
    address        text not null,
    active         boolean not null,
    joined_tx      text not null,
    claimed_amount bigint,
    claimed_tx     text,
    primary key (pot_id, address)
);
create index members_address_idx on members (address);

create table checkins (
    pot_id        bigint not null references pots (id),
    address       text not null,
    period        integer not null,
    reps          integer not null,
    evidence_hash text not null,
    tx_hash       text not null,
    block_number  bigint not null,
    recorded_at   timestamptz not null default now(),
    primary key (pot_id, address, period)
);

create table workouts (
    id            uuid primary key,
    pot_id        bigint not null references pots (id),
    address       text not null,
    period        integer not null,
    reps_target   integer not null,
    status        text not null check (status in ('started', 'submitting', 'recorded', 'rejected', 'failed')),
    started_at    timestamptz not null default now(),
    completed_at  timestamptz,
    reps          integer,
    telemetry     text,
    evidence_hash text unique,
    reject_reason text,
    tx_hash       text,
    latency_ms    integer
);
create index workouts_member_idx on workouts (pot_id, address, period);

create table indexer_state (
    id         boolean primary key default true check (id),
    last_block bigint not null
);
