import { useMemo, type ReactNode } from "react";
import { Button, ButtonLink } from "../components/Button";
import { PotList } from "../components/PotList";
import { ChallengeHub } from "../features/challenges/ChallengeHub";
import { PushupDemo } from "../features/guide/PushupDemo";
import { usePosePrefetch } from "../features/workout/usePosePrefetch";
import { useAuth } from "../lib/auth";
import { describeError } from "../lib/errors";
import { useMyPots } from "../lib/queries";

const steps = [
  {
    title: "Stake",
    body: "Join an official challenge, or start a pot and invite your friends with a link. Everyone puts in the same amount of USDC before it starts.",
  },
  {
    title: "Do your reps",
    body: "Your phone camera counts each pushup. Every finished set is recorded on Arc in about a second.",
  },
  {
    title: "Split the pot",
    body: "Finish every day and you share the stakes of everyone who didn't, minus a small fee for PushPot. If everyone finishes, or nobody does, everyone gets their money back.",
  },
];

export default function Home() {
  usePosePrefetch();
  const auth = useAuth();
  const signedIn = auth.status === "authenticated";
  const mine = useMyPots(auth.address, signedIn);
  const joined = useMemo(() => new Set(mine.data?.map((pot) => pot.id)), [mine.data]);

  return (
    <>
      <section className="pt-8 pb-12">
        <h1 className="font-display text-[clamp(3.9rem,20vw,6.5rem)] leading-[0.84] font-black uppercase">
          Stake USDC on your pushups.
        </h1>
        <p className="mt-5 max-w-[34ch] text-lg text-chalk/85">
          Join a challenge or start one with friends, then do your reps on camera. Miss a day and
          your stake goes to the people who didn't.
        </p>
        <div className="mt-8 grid gap-3">
          <ButtonLink to="/practice" className="min-h-14 text-2xl">
            Try it now
          </ButtonLink>
          <ButtonLink to="/create" variant="secondary" className="min-h-14 text-2xl">
            Create a pot
          </ButtonLink>
        </div>
        <p className="mt-3 text-sm text-mute">
          Trying it needs only your camera. No wallet, no money.
        </p>
      </section>

      <PushupDemo className="mb-12" />

      <ChallengeHub joined={joined} />

      {signedIn && (
        <PotSection title="Your pots" query={mine} empty="You're not in any pots yet." />
      )}

      <section className="mt-12" aria-labelledby="how-it-works">
        <h2 id="how-it-works" className="font-display text-4xl font-extrabold">
          How it works
        </h2>
        <ol className="mt-5 space-y-5">
          {steps.map((step, i) => (
            <li key={step.title} className="grid grid-cols-[3rem_1fr] gap-x-3">
              <span className="font-display text-5xl leading-[0.9] font-black text-volt">
                {i + 1}
              </span>
              <div>
                <h3 className="font-display text-2xl leading-tight font-extrabold">{step.title}</h3>
                <p className="text-mute">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-12 rounded-2xl border border-line bg-panel px-4 py-5" aria-labelledby="do-it-right">
        <h2 id="do-it-right" className="font-display text-4xl font-extrabold">
          Do it right
        </h2>
        <p className="mt-2 text-mute">
          A rep counts when you go down to about 90°, lock out at the top and keep your body in one
          straight line. Set your phone on the floor, sideways to you, with your whole body in frame.
        </p>
        <ButtonLink to="/guide" variant="secondary" className="mt-4 w-full">
          Read the guide
        </ButtonLink>
      </section>
    </>
  );
}

interface PotSectionProps {
  title: string;
  query: ReturnType<typeof useMyPots>;
  empty: ReactNode;
}

function PotSection({ title, query, empty }: PotSectionProps) {
  return (
    <section className="mt-10" aria-label={title}>
      <h2 className="mb-3 font-display text-4xl font-extrabold">{title}</h2>
      {query.isPending ? (
        <div className="h-28 animate-pulse rounded-2xl border border-line bg-panel" />
      ) : query.isError ? (
        <div className="rounded-2xl border border-line bg-panel px-4 py-4">
          <p className="text-mute">Couldn't load pots. {describeError(query.error)}</p>
          <Button variant="secondary" className="mt-3" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : query.data.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-5 text-mute">{empty}</p>
      ) : (
        <PotList pots={query.data} />
      )}
    </section>
  );
}
