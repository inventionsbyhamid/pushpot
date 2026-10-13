import { Link } from "react-router";
import { useNow } from "../hooks/useNow";
import { formatUsdc } from "../lib/format";
import { cadenceLabel, lengthLabel, potClock, scheduleLabel } from "../lib/pot";
import type { Pot } from "../lib/types";

export function PotList({ pots }: { pots: Pot[] }) {
  const now = useNow(30_000);
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
      {pots.map((pot) => {
        const clock = potClock(pot, now);
        return (
          <li key={pot.id}>
            <Link
              to={`/p/${pot.id}`}
              className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-raised active:bg-raised"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-2xl leading-tight font-extrabold">
                  {pot.title}
                </p>
                <p className="text-sm text-mute">
                  {cadenceLabel(pot)}, {lengthLabel(pot)}
                </p>
                <p
                  className={`mt-1 text-sm font-semibold ${clock.phase === "active" ? "text-volt" : clock.phase === "upcoming" ? "text-amber" : "text-mute"}`}
                >
                  {scheduleLabel(pot, clock, now)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-3xl leading-none font-black">
                  {formatUsdc(pot.stake, { symbol: false })}
                </p>
                <p className="text-xs text-mute">USDC stake</p>
                <p className="mt-1 text-xs text-mute tabular-nums">
                  {pot.member_count}/{pot.max_members} in
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
