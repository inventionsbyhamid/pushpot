import { parseUnits } from "viem";
import { usdcDecimals } from "../../lib/config";

export const MAX_TITLE_BYTES = 48;
export const MAX_REPS = 1000;
export const MIN_MEMBERS = 2;
export const MAX_MEMBERS = 50;
const MIN_LEAD_MS = 60_000;
const MAX_START_DELAY_MS = 30 * 24 * 60 * 60 * 1000;

export const repOptions = [10, 20, 50] as const;

export type PlanId = "3d" | "7d" | "14d" | "sprint";

export const plans: Record<PlanId, { periods: number; periodSeconds: number }> = {
  "3d": { periods: 3, periodSeconds: 86_400 },
  "7d": { periods: 7, periodSeconds: 86_400 },
  "14d": { periods: 14, periodSeconds: 86_400 },
  sprint: { periods: 3, periodSeconds: 600 },
};

export const stakeOptions = [1, 5, 10, 25].map((usdc) => ({
  usdc,
  value: parseUnits(String(usdc), usdcDecimals),
}));
export const defaultStake = parseUnits("5", usdcDecimals);

export type StartId = "soon" | "tomorrow" | "custom";

/** Start time in ms for the chosen option, or null if the custom value is empty or invalid. */
export function resolveStart(option: StartId, custom: string, now: number): number | null {
  switch (option) {
    case "soon":
      return Math.ceil((now + 15 * 60_000) / 60_000) * 60_000;
    case "tomorrow": {
      const at = new Date(now);
      at.setDate(at.getDate() + 1);
      at.setHours(6, 0, 0, 0);
      return at.getTime();
    }
    case "custom": {
      // datetime-local values carry no offset, so they parse as local time.
      const at = custom ? new Date(custom).getTime() : Number.NaN;
      return Number.isNaN(at) ? null : at;
    }
  }
}

export function startError(start: number | null, now: number): string | null {
  if (start === null) return "Pick a start time.";
  if (start < now + MIN_LEAD_MS) return "Pick a time at least a minute from now.";
  if (start > now + MAX_START_DELAY_MS) return "Pick a time within the next 30 days.";
  return null;
}

export function startBounds(now: number): { min: string; max: string } {
  return { min: toLocalInput(now + MIN_LEAD_MS), max: toLocalInput(now + MAX_START_DELAY_MS) };
}

/** Formats a timestamp for a datetime-local input, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}
