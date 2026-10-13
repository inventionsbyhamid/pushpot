import type { ReactNode } from "react";
import { Link } from "react-router";
import { Button, ButtonLink } from "../components/Button";
import { PotList } from "../components/PotList";
import { useAuth } from "../lib/auth";
import { describeError } from "../lib/errors";
import { usePots } from "../lib/queries";

const steps = [
  {
    title: "Stake",
    body: "Everyone puts the same amount of USDC into the pot before it starts.",
  },
  {
    title: "Do your reps",
    body: "Your phone camera counts each pushup. Every finished set is recorded on Arc in about a second.",
  },
  {
    title: "Split the pot",
    body: "Finish every day and you share the stakes of everyone who didn't. If nobody finishes, everyone gets their money back.",
  },
];

export default function Home() {
  const auth = useAuth();
  const signedIn = auth.status === "authenticated";
  const open = usePots("open");
  const mine = usePots("mine", auth.address, signedIn);

  return (
    <>
      <section className="pt-8 pb-12">
        <h1 className="font-display text-[clamp(3.9rem,20vw,6.5rem)] leading-[0.84] font-black uppercase">
          Stake USDC on your pushups.
        </h1>
        <p className="mt-5 max-w-[34ch] text-lg text-chalk/85">
          Put money in a pot with friends and do your reps on camera every day. Miss a day and your
          stake goes to the people who didn't.
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

      {signedIn && (
        <PotSection title="Your pots" query={mine} empty="You're not in any pots yet." />
      )}

      <PotSection
        title="Open pots"
        query={open}
        empty={
          <>
            No open pots right now.{" "}
            <Link to="/create" className="font-semibold text-volt underline underline-offset-4">
              Start one
            </Link>{" "}
            and invite your friends.
          </>
        }
      />

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
    </>
  );
}

interface PotSectionProps {
  title: string;
  query: ReturnType<typeof usePots>;
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
