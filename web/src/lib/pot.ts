import { formatDuration } from "./format";
import type { Member, Pot } from "./types";

/** Mirrors `PushPot.GRACE`: late check-ins are accepted, and claims open, this long after a deadline. */
export const GRACE_MS = 5 * 60 * 1000;

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const BPS = 10_000n;

export type PotPhase = "upcoming" | "active" | "settling" | "ended";

export interface PotClock {
  phase: PotPhase;
  /** Index of the running period while active. */
  period: number | null;
  startsAt: number;
  endsAt: number;
  periodEndsAt: number | null;
  claimsOpenAt: number;
}

/** Derives the pot's phase from its schedule so the UI rolls over without waiting for the API. */
export function potClock(
  pot: Pick<Pot, "start_time" | "period_seconds" | "periods">,
  now: number,
): PotClock {
  const startsAt = Date.parse(pot.start_time);
  const periodMs = pot.period_seconds * 1000;
  const endsAt = startsAt + pot.periods * periodMs;
  const claimsOpenAt = endsAt + GRACE_MS;

  if (now < startsAt) {
    return { phase: "upcoming", period: null, startsAt, endsAt, periodEndsAt: null, claimsOpenAt };
  }
  if (now < endsAt) {
    const period = Math.floor((now - startsAt) / periodMs);
    const periodEndsAt = startsAt + (period + 1) * periodMs;
    return { phase: "active", period, startsAt, endsAt, periodEndsAt, claimsOpenAt };
  }
  const phase = now < claimsOpenAt ? "settling" : "ended";
  return { phase, period: null, startsAt, endsAt, periodEndsAt: null, claimsOpenAt };
}

/** done/missed: settled; late: past the deadline but still inside the grace window. */
export type PeriodMark = "done" | "missed" | "late" | "live" | "future";

export function periodMarks(pot: Pot, member: Member, clock: PotClock, now: number): PeriodMark[] {
  const checked = new Set(member.checked_in);
  const periodMs = pot.period_seconds * 1000;
  return Array.from({ length: pot.periods }, (_, p): PeriodMark => {
    if (checked.has(p)) return "done";
    const opensAt = clock.startsAt + p * periodMs;
    const closesAt = opensAt + periodMs;
    if (now < opensAt) return "future";
    if (now < closesAt) return "live";
    return now < closesAt + GRACE_MS ? "late" : "missed";
  });
}

export type MemberState = "waiting" | "done" | "pending" | "out" | "finished";

export function memberState(pot: Pot, member: Member, clock: PotClock, now: number): MemberState {
  if (clock.phase === "upcoming") return "waiting";
  const marks = periodMarks(pot, member, clock, now);
  if (member.out || marks.includes("missed")) return "out";
  if (clock.phase !== "active") {
    return member.completed || marks.every((m) => m === "done") ? "finished" : "pending";
  }
  return marks[clock.period ?? 0] === "done" ? "done" : "pending";
}

export type PeriodUnit = "day" | "week" | "round";

export function periodUnit(pot: Pick<Pot, "period_seconds">): PeriodUnit {
  if (pot.period_seconds === DAY_SECONDS) return "day";
  if (pot.period_seconds === WEEK_SECONDS) return "week";
  return "round";
}

const periodNames: Record<PeriodUnit, string> = { day: "Day", week: "Week", round: "Round" };

export function periodName(pot: Pick<Pot, "period_seconds">): string {
  return periodNames[periodUnit(pot)];
}

function periodLength(seconds: number): string {
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "hour" : `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} min`;
}

type Schedule = Pick<Pot, "period_seconds" | "reps_per_period" | "periods">;

/** "20 pushups a day" / "100 pushups once a week" / "10 pushups every 10 min". */
export function cadenceLabel(pot: Omit<Schedule, "periods">): string {
  const unit = periodUnit(pot);
  const every =
    unit === "day"
      ? "a day"
      : unit === "week"
        ? "once a week"
        : `every ${periodLength(pot.period_seconds)}`;
  return `${pot.reps_per_period} pushups ${every}`;
}

/** "7 days" / "52 weeks" / "3 rounds". */
export function lengthLabel(pot: Omit<Schedule, "reps_per_period">): string {
  return `${pot.periods} ${periodUnit(pot)}${pot.periods === 1 ? "" : "s"}`;
}

/**
 * The whole commitment in plain words: "50 pushups today", "20 pushups a day for 7 days",
 * "100 pushups once a week for 52 weeks". `live` marks a single-period pot that is running.
 */
export function planLabel(pot: Schedule, live = false): string {
  if (pot.periods > 1) return `${cadenceLabel(pot)} for ${lengthLabel(pot)}`;
  const unit = periodUnit(pot);
  if (unit === "day" && live) return `${pot.reps_per_period} pushups today`;
  const within = unit === "round" ? periodLength(pot.period_seconds) : `one ${unit}`;
  return `${pot.reps_per_period} pushups in ${within}`;
}

export function potTotal(pot: Pick<Pot, "stake" | "member_count">): bigint {
  return BigInt(pot.stake) * BigInt(pot.member_count);
}

export function parsePotId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  return Number(raw);
}

/** Case-insensitive address match that tolerates malformed input from the API. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export interface PayoutEstimate {
  /** Platform fee if exactly `finishers` members complete. */
  fee: bigint;
  /** Each finisher's payout, or null when nobody finishes and everyone is refunded. */
  share: bigint | null;
}

/**
 * Mirrors the contract's payout: the fee comes only out of forfeited stakes, and there is none
 * when nobody finishes. The last claimer also takes the rounding remainder, so this can be a
 * base unit short.
 */
export function estimatePayout(
  pot: Pick<Pot, "stake" | "member_count" | "fee_bps">,
  finishers: number,
): PayoutEstimate {
  if (finishers <= 0) return { fee: 0n, share: null };
  const forfeited = BigInt(pot.stake) * BigInt(Math.max(0, pot.member_count - finishers));
  const fee = (forfeited * BigInt(pot.fee_bps)) / BPS;
  return { fee, share: (potTotal(pot) - fee) / BigInt(finishers) };
}

export interface Countdown {
  label: string;
  /** Seconds to go, or null once there's nothing left to wait for. */
  seconds: number | null;
}

/**
 * What the pot is waiting on: its start, the end of the running period, or claims opening.
 * `joining` phrases the start as the joining deadline, which is the same moment.
 */
export function potCountdown(
  pot: Pick<Pot, "period_seconds" | "periods">,
  clock: PotClock,
  now: number,
  { joining = false } = {},
): Countdown {
  const until = (at: number) => Math.max(0, (at - now) / 1000);
  switch (clock.phase) {
    case "upcoming":
      return { label: joining ? "Joining closes in" : "Starts in", seconds: until(clock.startsAt) };
    case "active":
      return {
        label:
          pot.periods === 1
            ? "Ends in"
            : `${periodName(pot)} ${(clock.period ?? 0) + 1} of ${pot.periods} · ends in`,
        seconds: until(clock.periodEndsAt ?? clock.endsAt),
      };
    case "settling":
      return { label: "Ended · claims open in", seconds: until(clock.claimsOpenAt) };
    case "ended":
      return { label: "Ended · claims open", seconds: null };
  }
}

/** "Starts in 3h 12m", "Day 3 of 7 · ends in 9h 3m", "Ended · claims open". */
export function countdownText({ label, seconds }: Countdown): string {
  return seconds === null ? label : `${label} ${formatDuration(seconds)}`;
}
