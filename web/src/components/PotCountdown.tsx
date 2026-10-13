import { countdownText, potCountdown, type PotClock, type PotPhase } from "../lib/pot";
import type { Pot } from "../lib/types";

const tone: Record<PotPhase, string> = {
  upcoming: "text-amber",
  active: "text-volt",
  settling: "text-mute",
  ended: "text-mute",
};

interface PotCountdownProps {
  pot: Pick<Pot, "period_seconds" | "periods">;
  clock: PotClock;
  now: number;
  className?: string;
}

/** One line saying what the pot is waiting on and how long is left. */
export function PotCountdown({ pot, clock, now, className = "" }: PotCountdownProps) {
  return (
    <p role="timer" className={`font-semibold tabular-nums ${tone[clock.phase]} ${className}`}>
      {countdownText(potCountdown(pot, clock, now))}
    </p>
  );
}
