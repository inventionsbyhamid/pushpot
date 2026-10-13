import { StreakBar } from "../../components/StreakBar";
import { addressUrl } from "../../lib/config";
import { formatUsdc, shortAddress } from "../../lib/format";
import {
  memberState,
  periodMarks,
  sameAddress,
  type MemberState,
  type PotClock,
} from "../../lib/pot";
import type { Member, Pot } from "../../lib/types";

const stateStyle: Record<MemberState, { icon: string; label: string; className: string }> = {
  waiting: { icon: "🤝", label: "Staked", className: "text-chalk" },
  done: { icon: "✅", label: "Done", className: "text-volt" },
  pending: { icon: "⏳", label: "Pending", className: "text-amber" },
  out: { icon: "💀", label: "Out", className: "text-flare" },
  finished: { icon: "🏆", label: "Finished", className: "text-volt" },
};

interface RosterProps {
  pot: Pot;
  members: Member[];
  clock: PotClock;
  now: number;
  viewer: string | undefined;
}

export function Roster({ pot, members, clock, now, viewer }: RosterProps) {
  // Official challenges are effectively uncapped, so only the head count matters there.
  const count = !pot.official
    ? `${pot.member_count} of ${pot.max_members}`
    : pot.member_count > 1
      ? `${pot.member_count} in`
      : null;
  const ordered = [...members].sort(
    (a, b) => Number(sameAddress(b.address, viewer)) - Number(sameAddress(a.address, viewer)),
  );

  return (
    <section aria-labelledby="roster" className="mt-10">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 id="roster" className="font-display text-4xl font-extrabold">
          Roster
        </h2>
        {count && <p className="text-sm text-mute tabular-nums">{count}</p>}
      </div>

      {members.length === 0 && (
        <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-mute">
          {clock.phase === "upcoming" ? "Nobody's in yet. Be the first." : "Nobody joined."}
        </p>
      )}
      <ul className="divide-y divide-line rounded-2xl border border-line bg-panel empty:hidden">
        {ordered.map((member) => {
          const you = sameAddress(member.address, viewer);
          const state = memberState(pot, member, clock, now);
          const style = stateStyle[state];
          // An eliminated member's remaining periods no longer matter.
          const marks = periodMarks(pot, member, clock, now).map((m) =>
            state === "out" && m === "live" ? "future" : m,
          );
          const done = marks.filter((m) => m === "done").length;
          return (
            <li
              key={member.address}
              className={`flex items-center gap-3 px-4 py-3 ${you ? "bg-volt/[0.06] shadow-[inset_3px_0_0_var(--color-volt)]" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2">
                  <a
                    href={addressUrl(member.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[0.95rem] hover:text-volt"
                  >
                    {shortAddress(member.address)}
                  </a>
                  {you && (
                    <span className="rounded bg-volt px-1.5 text-xs leading-5 font-bold text-ink">
                      You
                    </span>
                  )}
                </p>
                <div className="mt-1.5 flex items-center gap-3">
                  <StreakBar marks={marks} label={`${done} of ${pot.periods} done`} />
                  <span className="text-xs text-mute tabular-nums">
                    {done}/{pot.periods}
                  </span>
                </div>
                {member.claimed_amount !== null && (
                  <p className="mt-1 text-xs text-mute">
                    Claimed {formatUsdc(member.claimed_amount)}
                  </p>
                )}
              </div>
              <div className={`shrink-0 text-right font-semibold ${style.className}`}>
                <span aria-hidden className="mr-1.5">
                  {style.icon}
                </span>
                {style.label}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
