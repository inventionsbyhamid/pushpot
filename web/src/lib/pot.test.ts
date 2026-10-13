import { describe, expect, it } from "vitest";
import { formatBps } from "./format";
import { countdownText, estimatePayout, planLabel, potClock, potCountdown } from "./pot";
import type { Pot } from "./types";

const DAY = 86_400;
const start = Date.parse("2026-10-13T00:00:00Z");

function pot(overrides: Partial<Pot> = {}): Pot {
  return {
    id: 1,
    title: "Iron Week",
    creator: "0x0000000000000000000000000000000000000001",
    stake: 5_000_000,
    reps_per_period: 50,
    periods: 7,
    period_seconds: DAY,
    start_time: new Date(start).toISOString(),
    end_time: new Date(start + 7 * DAY * 1000).toISOString(),
    max_members: 1000,
    member_count: 10,
    status: "upcoming",
    current_period: null,
    official: true,
    fee_bps: 500,
    ...overrides,
  };
}

describe("planLabel", () => {
  it("describes multi-period pots by cadence and length", () => {
    expect(planLabel(pot({ reps_per_period: 20 }))).toBe("20 pushups a day for 7 days");
    expect(planLabel(pot({ reps_per_period: 100, periods: 52, period_seconds: 7 * DAY }))).toBe(
      "100 pushups once a week for 52 weeks",
    );
    expect(planLabel(pot({ reps_per_period: 10, periods: 3, period_seconds: 600 }))).toBe(
      "10 pushups every 10 min for 3 rounds",
    );
  });

  it("says today only while a one-day pot is running", () => {
    expect(planLabel(pot({ periods: 1 }), true)).toBe("50 pushups today");
    expect(planLabel(pot({ periods: 1 }))).toBe("50 pushups in one day");
  });
});

describe("potCountdown", () => {
  const at = (iso: string) => Date.parse(iso);

  it("counts down to the start, phrased as the joining deadline when asked", () => {
    const now = at("2026-10-12T19:48:00Z");
    const p = pot();
    const clock = potClock(p, now);
    expect(countdownText(potCountdown(p, clock, now))).toBe("Starts in 4h 12m");
    expect(countdownText(potCountdown(p, clock, now, { joining: true }))).toBe(
      "Joining closes in 4h 12m",
    );
  });

  it("counts down to the end of the running period", () => {
    const now = at("2026-10-15T14:57:00Z");
    const p = pot();
    expect(countdownText(potCountdown(p, potClock(p, now), now))).toBe(
      "Day 3 of 7 · ends in 9h 3m",
    );

    const weekly = pot({ periods: 52, period_seconds: 7 * DAY });
    const later = at("2026-11-14T00:00:00Z");
    expect(countdownText(potCountdown(weekly, potClock(weekly, later), later))).toBe(
      "Week 5 of 52 · ends in 3d",
    );

    const single = pot({ periods: 1 });
    const today = at("2026-10-13T20:00:00Z");
    expect(countdownText(potCountdown(single, potClock(single, today), today))).toBe("Ends in 4h");
  });

  it("waits for claims after the end", () => {
    const p = pot({ periods: 1 });
    const settling = start + DAY * 1000 + 60_000;
    expect(countdownText(potCountdown(p, potClock(p, settling), settling))).toBe(
      "Ended · claims open in 4m",
    );
    const ended = start + 2 * DAY * 1000;
    expect(potCountdown(p, potClock(p, ended), ended)).toEqual({
      label: "Ended · claims open",
      seconds: null,
    });
  });
});

describe("estimatePayout", () => {
  it("takes the fee from forfeited stakes only", () => {
    // 10 × 5 USDC; 6 forfeit 30 USDC, of which 5% (1.5 USDC) is the fee.
    expect(estimatePayout(pot(), 4)).toEqual({ fee: 1_500_000n, share: 12_125_000n });
  });

  it("charges nothing when everyone or nobody finishes", () => {
    expect(estimatePayout(pot(), 10)).toEqual({ fee: 0n, share: 5_000_000n });
    expect(estimatePayout(pot(), 0)).toEqual({ fee: 0n, share: null });
  });

  it("rounds like the contract", () => {
    // 3 × 1 USDC, one forfeit at 3.33%: fee floors to 33,300; shares floor too.
    const p = pot({ stake: 1_000_000, member_count: 3, fee_bps: 333 });
    expect(estimatePayout(p, 2)).toEqual({ fee: 33_300n, share: 1_483_350n });
  });
});

describe("formatBps", () => {
  it("drops needless decimals", () => {
    expect(formatBps(500)).toBe("5%");
    expect(formatBps(250)).toBe("2.5%");
    expect(formatBps(0)).toBe("0%");
  });
});
