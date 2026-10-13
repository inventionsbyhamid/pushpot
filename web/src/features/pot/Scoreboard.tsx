import { ScoreDigits } from "../../components/ScoreDigits";
import { formatClock, formatUsdc, formatUsdcApprox } from "../../lib/format";
import { periodName, potTotal, type PotClock } from "../../lib/pot";
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

function countdown(pot: Pot, clock: PotClock): { label: string; at: number | null } {
  switch (clock.phase) {
    case "upcoming":
      return { label: "Starts in", at: clock.startsAt };
    case "active":
      return {
        label: `${periodName(pot)} ${(clock.period ?? 0) + 1} ends in`,
        at: clock.periodEndsAt,
      };
    case "settling":
      return { label: "Claims open in", at: clock.claimsOpenAt };
    case "ended":
      return { label: "Result", at: null };
  }
}

export function Scoreboard({ pot, clock, now, stillIn, viewerStillIn }: ScoreboardProps) {
  const total = potTotal(pot);
  const share = stillIn > 0 ? total / BigInt(stillIn) : null;
  const timer = countdown(pot, clock);
  const started = clock.phase !== "upcoming";
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
          <p className="text-sm text-mute">{timer.label}</p>
          <p className="font-display text-[2.5rem] leading-none font-black">
            {timer.at === null ? (
              "Final"
            ) : (
              <ScoreDigits value={formatClock((timer.at - now) / 1000)} />
            )}
          </p>
        </div>
        <div className="px-4 py-3 text-right">
          <p className="text-sm text-mute">
            {clock.phase === "ended" ? "Finished" : started ? "Still in" : "Players"}
          </p>
          <p className="font-display text-[2.5rem] leading-none font-black tabular-nums">
            {started ? stillIn : pot.member_count}
            <span className="text-2xl text-mute">
              /{started ? pot.member_count : pot.max_members}
            </span>
          </p>
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3 border-t-2 border-line bg-panel/80 px-4 py-3">
        {share === null ? (
          <p className="text-sm">Nobody finished, so everyone gets their stake back.</p>
        ) : (
          <>
            <p className="text-sm text-mute">
              {viewerStillIn ? "Your share if you finish" : "Each finisher gets"}
            </p>
            <p className="font-display text-2xl leading-none font-extrabold text-volt">
              {formatUsdcApprox(share)}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
