import { useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router";
import { Button } from "../../components/Button";
import { useNow } from "../../hooks/useNow";
import { describeError } from "../../lib/errors";
import { potClock } from "../../lib/pot";
import { useChallenges } from "../../lib/queries";
import type { Cadence, Challenge } from "../../lib/types";
import { CadenceTabs, tabId } from "./CadenceTabs";
import { ChallengeCard } from "./ChallengeCard";
import { cadences, storeCadence, storedCadence } from "./cadences";

/** Official challenges by cadence: open ones to join first, then the ones under way. */
export function ChallengeHub({ joined }: { joined: ReadonlySet<number> }) {
  const query = useChallenges();
  const now = useNow();
  const [cadence, setCadence] = useState(storedCadence);
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  const { hash } = useLocation();
  const section = useRef<HTMLElement>(null);

  // The router scrolls to the hash only if Home had already loaded when it navigated.
  useEffect(() => {
    if (hash === "#challenges") section.current?.scrollIntoView();
  }, [hash]);

  const select = (next: Cadence) => {
    setCadence(next);
    storeCadence(next);
  };

  return (
    <section
      ref={section}
      id="challenges"
      aria-labelledby={`${idBase}-title`}
      className="scroll-mt-20"
    >
      <h2 id={`${idBase}-title`} className="font-display text-4xl font-extrabold">
        Official challenges
      </h2>
      <p className="mt-1 mb-4 text-mute">
        Open to everyone. Join before the start, then hit your reps on time.
      </p>

      <CadenceTabs value={cadence} onChange={select} idBase={idBase} panelId={panelId} />

      <div id={panelId} role="tabpanel" aria-labelledby={tabId(idBase, cadence)} className="mt-4">
        {query.isPending ? (
          <div role="status" className="space-y-3">
            <span className="sr-only">Loading challenges</span>
            {[0, 1].map((i) => (
              <div key={i} className="h-72 animate-pulse rounded-2xl border border-line bg-panel" />
            ))}
          </div>
        ) : query.isError ? (
          <div className="rounded-2xl border border-line bg-panel px-4 py-4">
            <p className="text-mute">Couldn't load challenges. {describeError(query.error)}</p>
            <Button variant="secondary" className="mt-3" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          // Keyed so switching tabs replays the entrance.
          <CadencePanel
            key={cadence}
            cadence={cadence}
            challenges={query.data}
            now={now}
            joined={joined}
          />
        )}
      </div>
    </section>
  );
}

interface CadencePanelProps {
  cadence: Cadence;
  challenges: Challenge[];
  now: number;
  joined: ReadonlySet<number>;
}

function CadencePanel({ cadence, challenges, now, joined }: CadencePanelProps) {
  const timed = challenges
    .filter((c) => c.template.cadence === cadence)
    .map((challenge) => ({ challenge, clock: potClock(challenge.plan, now) }));
  // Phases come from the clock, so a challenge moves along the moment it starts or ends.
  const open = timed.filter((c) => c.clock.phase === "upcoming");
  // One nobody opened before its start has nobody in it.
  const running = timed.filter((c) => c.clock.phase === "active" && c.challenge.pot);
  const schedule = cadences.find((c) => c.id === cadence)?.schedule;

  const cards = (items: typeof timed, offset = 0) => (
    <ul className="space-y-3">
      {items.map(({ challenge, clock }, i) => (
        <ChallengeCard
          key={`${challenge.template.key}@${challenge.plan.start_time}`}
          challenge={challenge}
          clock={clock}
          now={now}
          joined={!!challenge.pot && joined.has(challenge.pot.id)}
          index={offset + i}
        />
      ))}
    </ul>
  );

  return (
    <>
      {open.length > 0 ? (
        cards(open)
      ) : (
        <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-mute">
          Nothing open to join right now. {schedule}
        </p>
      )}
      {running.length > 0 && (
        <div className="mt-8">
          <h3 className="mb-3 font-display text-2xl font-extrabold">Under way</h3>
          {cards(running, open.length)}
        </div>
      )}
    </>
  );
}
