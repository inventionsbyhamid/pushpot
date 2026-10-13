import { ScoreDigits } from "../../components/ScoreDigits";
import { formatBps, formatClock, formatUsdc, formatUsdcApprox } from "../../lib/format";
import { estimatePayout, periodUnit, potCountdown, potTotal, type PotClock } from "../../lib/pot";
import type { Pot } from "../../lib/types";

interface ScoreboardProps {
  pot: Pot;
  clock: PotClock;
  now: number;
  /** Members who haven't missed a period yet. */
  stillIn: number;
  /** The viewer is a member who can still finish. */
  viewerStillIn: boolean;
}

export function Scoreboard({ pot, clock, now, stillIn, viewerStillIn }: ScoreboardProps) {
  const total = potTotal(pot);
  const { fee, share } = estimatePayout(pot, stillIn);
  const timer = potCountdown(pot, clock, now);
  const started = clock.phase !== "upcoming";
  // Official challenges allow up to a thousand players, so the cap isn't worth showing.
  const outOf = started ? pot.member_count : pot.official ? null : pot.max_members;
  const amount = formatUsdc(total, { symbol: false });
  // Scale the figure so it and its unit stay on one line, from "5.00" up to "2,500.00".
  const amountEm = [...amount].reduce((em, char) => em + (/\d/.test(char) ? 0.62 : 0.3), 1);

  return (
    <section
      aria-label="Scoreboard"
      className="dot-matrix overflow-hidden rounded-2xl border-2 border-line bg-ink"
    >
      <div className="@container px-4 pt-3 pb-4">
        <p className="text-sm text-mute">In the pot</p>
        <p
          className="font-display leading-[0.9] font-black whitespace-nowrap text-volt glow-volt"
          style={{ fontSize: `min(6rem, ${(100 / amountEm).toFixed(2)}cqw)` }}
        >
          <ScoreDigits key={amount} value={amount} />
          <span className="ml-[0.12em] text-[0.36em] text-chalk [text-shadow:none]">USDC</span>
        </p>
      </div>

      <div className="grid grid-cols-[1fr_auto] border-t-2 border-line">
        <div className="border-r-2 border-line px-4 py-3">
          <p className="text-sm text-mute">{timer.seconds === null ? "Result" : timer.label}</p>
          <p className="font-display text-[2.5rem] leading-none font-black">
            {timer.seconds === null ? "Final" : <ScoreDigits value={formatClock(timer.seconds)} />}
          </p>
        </div>
        <div className="px-4 py-3 text-right">
          <p className="text-sm text-mute">
            {clock.phase === "ended" ? "Finished" : started ? "Still in" : "Players"}
          </p>
          <p className="font-display text-[2.5rem] leading-none font-black tabular-nums">
            {started ? stillIn : pot.member_count}
            {outOf !== null && <span className="text-2xl text-mute">/{outOf}</span>}
          </p>
        </div>
      </div>

      <div className="border-t-2 border-line bg-panel/80 px-4 py-3">
        {pot.member_count === 0 ? (
          // Official challenges open empty, since the platform doesn't stake.
          <p className="text-sm">
            {started
              ? "Nobody joined this one."
              : `Nobody's in yet. Finishers split the stakes of everyone who misses a ${periodUnit(pot)}.`}
          </p>
        ) : share === null ? (
          <p className="text-sm">Nobody finished, so everyone gets their stake back.</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-mute">
                {viewerStillIn ? "Your share if you finish" : "Each finisher gets"}
              </p>
              <p className="font-display text-2xl leading-none font-extrabold text-volt">
                {formatUsdcApprox(share)}
              </p>
            </div>
            {pot.fee_bps > 0 && (
              <div className="mt-1.5 flex items-baseline justify-between gap-3 text-sm text-mute">
                <p>{formatBps(pot.fee_bps)} of forfeits to PushPot</p>
                <p className="tabular-nums">{formatUsdcApprox(fee)}</p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
