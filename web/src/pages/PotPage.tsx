import { useParams } from "react-router";
import { useAccount } from "wagmi";
import { Button } from "../components/Button";
import { PageSpinner } from "../components/PageSpinner";
import { StatusBadge } from "../components/StatusBadge";
import { ActivityFeed } from "../features/pot/ActivityFeed";
import { PotActionBar } from "../features/pot/PotActionBar";
import { Roster } from "../features/pot/Roster";
import { Scoreboard } from "../features/pot/Scoreboard";
import { ShareCard } from "../features/pot/ShareCard";
import { useNow } from "../hooks/useNow";
import { usePotEvents } from "../hooks/usePotEvents";
import { ApiError } from "../lib/api";
import { describeError } from "../lib/errors";
import { formatDateTime, formatUsdc, shortAddress } from "../lib/format";
import {
  cadenceLabel,
  lengthLabel,
  memberState,
  parsePotId,
  potClock,
  sameAddress,
} from "../lib/pot";
import { usePot } from "../lib/queries";
import NotFound from "./NotFound";

export default function PotPage() {
  const potId = parsePotId(useParams().id);
  const { address } = useAccount();
  const query = usePot(potId);
  const activity = usePotEvents(potId, address);
  const now = useNow();

  if (potId === null) return <NotFound message="That pot link doesn't look right." />;
  if (query.isPending) {
    return query.failureCount > 0 ? (
      <PageSpinner message="Syncing the pot from Arc" />
    ) : (
      <PageSpinner label="Loading pot" />
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <NotFound message={`There's no pot #${potId}.`} />;
    }
    return (
      <section className="py-16">
        <h1 className="font-display text-4xl font-extrabold">Couldn't load this pot</h1>
        <p className="mt-2 text-mute">{describeError(query.error)}</p>
        <Button className="mt-6 w-full" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </section>
    );
  }

  const { pot, members } = query.data;
  const clock = potClock(pot, now);
  const me = members.find((m) => sameAddress(m.address, address)) ?? null;
  const meState = me ? memberState(pot, me, clock, now) : null;
  const stillIn = members.filter((m) => memberState(pot, m, clock, now) !== "out").length;
  const inviting = clock.phase === "upcoming" && pot.member_count < pot.max_members;

  return (
    <div className="pb-40">
      <header className="pt-6 pb-5">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 font-display text-5xl leading-[0.95] font-black break-words">
            {pot.title}
          </h1>
          <div className="pt-1.5">
            <StatusBadge phase={clock.phase} />
          </div>
        </div>
        <p className="mt-2 text-lg">
          {cadenceLabel(pot)} for {lengthLabel(pot)}.{" "}
          <span className="text-mute">{formatUsdc(pot.stake)} to play.</span>
        </p>
        <p className="mt-1 text-sm text-mute">
          {formatDateTime(clock.startsAt)} to {formatDateTime(clock.endsAt)}. Started by{" "}
          <span className="font-mono">
            {sameAddress(pot.creator, address) ? "you" : shortAddress(pot.creator)}
          </span>
          .
        </p>
      </header>

      <Scoreboard
        pot={pot}
        clock={clock}
        now={now}
        stillIn={stillIn}
        viewerStillIn={!!me && meState !== "out"}
      />

      <ActivityFeed pot={pot} activity={activity} viewer={address} now={now} />
      <Roster pot={pot} members={members} clock={clock} now={now} viewer={address} />
      <ShareCard pot={pot} inviting={inviting} />

      <PotActionBar pot={pot} clock={clock} now={now} me={me} meState={meState} />
    </div>
  );
}
