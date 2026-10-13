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
