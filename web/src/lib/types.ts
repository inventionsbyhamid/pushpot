export type PotStatus = "upcoming" | "active" | "ended";

export interface Pot {
  id: number;
  title: string;
  creator: string;
  stake: number;
  reps_per_period: number;
  periods: number;
  period_seconds: number;
  start_time: string;
  end_time: string;
  max_members: number;
  member_count: number;
  status: PotStatus;
  current_period: number | null;
  /** Opened by the platform and joinable by anyone, rather than invite-only. */
  official: boolean;
  /** Platform fee on forfeited stakes, in basis points, fixed when the pot was created. */
  fee_bps: number;
}

export interface Member {
  address: string;
  checked_in: number[];
  completed: boolean;
  out: boolean;
  claimed_amount: number | null;
}

export interface PotDetail {
  pot: Pot;
  members: Member[];
}

export type Cadence = "daily" | "weekly" | "weekend" | "monthly" | "yearly";

export type Tier = "rookie" | "regular" | "beast";

export interface ChallengeTemplate {
  key: string;
  cadence: Cadence;
  name: string;
  tier: Tier;
  tagline: string;
}

/** A challenge's terms, known from the schedule before it exists on chain. */
export interface ChallengePlan {
  title: string;
  stake: number;
  reps_per_period: number;
  periods: number;
  period_seconds: number;
  start_time: string;
  end_time: string;
  max_members: number;
}

export interface Challenge {
  template: ChallengeTemplate;
  plan: ChallengePlan;
  /** Null until someone opens the challenge by joining it. */
  pot: Pot | null;
}

export interface StartedWorkout {
  workout_id: string;
  period: number;
  reps_target: number;
  period_ends_at: string;
}

export interface RecordedWorkout {
  status: "recorded";
  tx_hash: string;
  latency_ms: number;
}

export type PotEventKind = "joined" | "left" | "checked_in" | "claimed";

export interface PotEvent {
  pot_id: number;
  kind: PotEventKind;
  address: string;
  period: number | null;
  reps: number | null;
  tx_hash: string;
}
