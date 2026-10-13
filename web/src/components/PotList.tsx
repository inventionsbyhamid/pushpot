import { Link } from "react-router";
import { useNow } from "../hooks/useNow";
import { formatUsdc } from "../lib/format";
import { planLabel, potClock } from "../lib/pot";
import type { Pot } from "../lib/types";
import { PotCountdown } from "./PotCountdown";
import { TallyIcon } from "./Wordmark";

/** "3/10 in" for invite-only pots; official ones are effectively uncapped, so just "37 in". */
function membersLabel(pot: Pot): string | null {
  if (!pot.official) return `${pot.member_count}/${pot.max_members} in`;
  return pot.member_count > 1 ? `${pot.member_count} in` : null;
}

export function PotList({ pots }: { pots: Pot[] }) {
  const now = useNow();
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
      {pots.map((pot) => {
        const clock = potClock(pot, now);
        const members = membersLabel(pot);
        return (
          <li key={pot.id}>
            <Link
              to={`/p/${pot.id}`}
              className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-raised active:bg-raised"
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-display text-2xl leading-tight font-extrabold">
                  {pot.official && (
                    <>
                      <TallyIcon className="h-4 w-5 shrink-0 text-volt" />
                      <span className="sr-only">Official challenge:</span>
                    </>
                  )}
                  <span className="truncate">{pot.title}</span>
                </p>
                <p className="text-sm text-mute">{planLabel(pot, clock.phase === "active")}</p>
                <PotCountdown pot={pot} clock={clock} now={now} className="mt-1 text-sm" />
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-3xl leading-none font-black">
                  {formatUsdc(pot.stake, { symbol: false })}
                </p>
                <p className="text-xs text-mute">USDC stake</p>
                {members && <p className="mt-1 text-xs text-mute tabular-nums">{members}</p>}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
