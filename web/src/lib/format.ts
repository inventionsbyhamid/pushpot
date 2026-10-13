import { formatUnits } from "viem";
import { usdcDecimals } from "./config";

function splitUsdc(value: bigint | number): { sign: string; whole: string; fraction: string } {
  const text = formatUnits(BigInt(value), usdcDecimals);
  const sign = text.startsWith("-") ? "-" : "";
  const [whole = "0", fraction = ""] = text.replace("-", "").split(".");
  return { sign, whole: whole.replace(/\B(?=(\d{3})+(?!\d))/g, ","), fraction };
}

/** USDC base units to a display string with at least two decimals and no rounding. */
export function formatUsdc(value: bigint | number, { symbol = true } = {}): string {
  const { sign, whole, fraction } = splitUsdc(value);
  const text = `${sign}${whole}.${fraction.padEnd(2, "0")}`;
  return symbol ? `${text} USDC` : text;
}

/** Rounded to cents for estimates, marked "≈" when that hides precision. */
export function formatUsdcApprox(value: bigint): string {
  const cent = 10n ** BigInt(usdcDecimals - 2);
  const rounded = ((value + cent / 2n) / cent) * cent;
  return rounded === value ? formatUsdc(value) : `≈${formatUsdc(rounded)}`;
}

/** All six decimals, matching what a wallet shows for the raw signed value. */
export function formatUsdcExact(value: bigint | number): string {
  const { sign, whole, fraction } = splitUsdc(value);
  return `${sign}${whole}.${fraction.padEnd(usdcDecimals, "0")} USDC`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-2)}`;
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

/** Two most significant units, e.g. "3h 12m", "2d 4h", "45s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return minutes < 10 && seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Scoreboard clock: "04:12:33" under a day, "12d 04h" beyond. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  if (days > 0) return `${days}d ${pad(hours)}h`;
  return `${pad(hours)}:${pad(Math.floor((s % 3_600) / 60))}:${pad(s % 60)}`;
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const relativeUnits: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

export function formatRelative(at: number, now: number = Date.now()): string {
  const delta = (at - now) / 1000;
  for (const [unit, size] of relativeUnits) {
    if (Math.abs(delta) >= size || unit === "second") {
      return relativeFormat.format(Math.round(delta / size), unit);
    }
  }
  return "";
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateTime(at: number): string {
  return dateTimeFormat.format(at);
}
