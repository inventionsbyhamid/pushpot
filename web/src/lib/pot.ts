import { formatDuration } from "./format";
import type { Member, Pot } from "./types";

/** Mirrors `PushPot.GRACE`: late check-ins are accepted, and claims open, this long after a deadline. */
export const GRACE_MS = 5 * 60 * 1000;

const DAY_SECONDS = 86_400;

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
export function potClock(pot: Pot, now: number): PotClock {
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

export function isDaily(pot: Pick<Pot, "period_seconds">): boolean {
  return pot.period_seconds === DAY_SECONDS;
}

export function periodName(pot: Pick<Pot, "period_seconds">): string {
  return isDaily(pot) ? "Day" : "Round";
}

function periodLength(seconds: number): string {
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS} days`;
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "hour" : `${seconds / 3_600} hours`;
  return `${Math.round(seconds / 60)} min`;
}

/** "20 pushups a day" / "10 pushups every 10 min". */
export function cadenceLabel(pot: Pick<Pot, "period_seconds" | "reps_per_period">): string {
  const every = isDaily(pot) ? "a day" : `every ${periodLength(pot.period_seconds)}`;
  return `${pot.reps_per_period} pushups ${every}`;
}

/** "7 days" / "3 rounds". */
export function lengthLabel(pot: Pick<Pot, "period_seconds" | "periods">): string {
  const unit = isDaily(pot) ? "day" : "round";
  return `${pot.periods} ${unit}${pot.periods === 1 ? "" : "s"}`;
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

/** Short schedule line for lists: "Starts in 3h 12m", "Day 3 of 7", "Ended". */
export function scheduleLabel(pot: Pot, clock: PotClock, now: number): string {
  switch (clock.phase) {
    case "upcoming":
      return `Starts in ${formatDuration((clock.startsAt - now) / 1000)}`;
    case "active":
      return `${periodName(pot)} ${(clock.period ?? 0) + 1} of ${pot.periods}`;
    default:
      return "Ended";
  }
}
