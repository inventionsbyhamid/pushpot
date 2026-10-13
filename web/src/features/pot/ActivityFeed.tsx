import { ExternalLink } from "../../components/ExternalLink";
import type { PotActivity } from "../../hooks/usePotEvents";
import { txUrl } from "../../lib/config";
import { formatRelative, formatUsdc, shortAddress } from "../../lib/format";
import { periodName, sameAddress } from "../../lib/pot";
import type { Pot, PotEvent } from "../../lib/types";

function describe(event: PotEvent, pot: Pot): string {
  switch (event.kind) {
    case "joined":
      return `joined and staked ${formatUsdc(pot.stake)}`;
    case "left":
      return "left and got their stake back";
    case "checked_in":
      return `did ${event.reps ?? pot.reps_per_period} pushups${event.period === null ? "" : ` for ${periodName(pot).toLowerCase()} ${event.period + 1}`}`;
    case "claimed":
      return "claimed their payout";
  }
}

interface ActivityFeedProps {
  pot: Pot;
  activity: PotActivity[];
  viewer: string | undefined;
  now: number;
}

/** Events seen live on this page, each linked to its transaction. */
export function ActivityFeed({ pot, activity, viewer, now }: ActivityFeedProps) {
  if (activity.length === 0) return null;

  return (
    <section aria-labelledby="activity" className="mt-10">
      <h2 id="activity" className="mb-3 font-display text-4xl font-extrabold">
        Just now
      </h2>
      <ul className="space-y-2">
        {activity.map(({ event, receivedAt }) => (
          <li
            key={`${event.tx_hash}-${event.kind}-${event.address}`}
            className="flex animate-toast-in items-baseline justify-between gap-3 rounded-xl border border-line bg-panel px-4 py-3"
          >
            <p className="min-w-0">
              <span className="font-mono">
                {sameAddress(event.address, viewer) ? "You" : shortAddress(event.address)}
              </span>{" "}
              {describe(event, pot)}
            </p>
            <ExternalLink href={txUrl(event.tx_hash)} className="shrink-0 text-sm text-mute">
              {formatRelative(receivedAt, now)}
            </ExternalLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
