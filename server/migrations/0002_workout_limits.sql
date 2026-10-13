-- Earlier versions could leave several open or stuck workouts per member and period. A 'failed'
-- workout can be completed exactly like a 'started' one, so parking them there loses nothing.
update workouts set status = 'failed' where status in ('started', 'submitting');

-- At most one workout per member and period is on its way to the chain (or already on it), and
-- at most one is waiting to be completed.
create unique index workouts_in_flight_idx on workouts (pot_id, address, period)
    where status in ('submitting', 'recorded');
create unique index workouts_open_idx on workouts (pot_id, address, period)
    where status = 'started';

-- Rejected attempts keep only their evidence hash and size.
alter table workouts add column telemetry_bytes integer;
update workouts set telemetry_bytes = octet_length(telemetry), telemetry = null
    where status = 'rejected';
alter table workouts drop constraint workouts_evidence_hash_key;
create unique index workouts_evidence_hash_idx on workouts (evidence_hash)
    where status <> 'rejected';

-- Hash of the decoded camera trace, so the same trace can't be submitted for another workout.
alter table workouts add column trace_fingerprint bytea;
create unique index workouts_trace_fingerprint_idx on workouts (trace_fingerprint);
