import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, ButtonLink } from "../components/Button";
import { ScoreDigits } from "../components/ScoreDigits";
import { celebrate } from "../features/workout/feedback";
import { WorkoutSession } from "../features/workout/WorkoutSession";
import type { WorkoutResult } from "../pose/types";

const BEST_KEY = "pushpot:practice-best";

function loadBest(): number {
  try {
    const stored = Number(localStorage.getItem(BEST_KEY));
    return Number.isInteger(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function saveBest(reps: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(reps));
  } catch {
    // Storage is unavailable (e.g. private browsing); the best just isn't remembered.
  }
}

export default function Practice() {
  const navigate = useNavigate();
  const [best, setBest] = useState(loadBest);
  const [round, setRound] = useState(0);
  const [last, setLast] = useState<{ reps: number; isBest: boolean } | null>(null);

  const complete = ({ reps }: WorkoutResult) => {
    const isBest = reps > best;
    if (isBest) {
      setBest(reps);
      saveBest(reps);
      celebrate();
    }
    setLast({ reps, isBest });
  };

  const again = () => {
    setLast(null);
    setRound((n) => n + 1);
  };

  if (!last) {
    return <WorkoutSession key={round} onComplete={complete} onExit={() => navigate("/")} />;
  }

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-ink text-chalk">
      <section className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-8 px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-safe text-center">
        <div>
          <p className="font-mono text-xs tracking-[0.2em] text-volt uppercase">
            {last.isBest ? "New personal best" : "Practice done"}
          </p>
          <ScoreDigits
            value={String(last.reps)}
            className="block font-display text-[clamp(7rem,40vmin,12rem)] leading-none font-black text-volt glow-volt"
          />
          <p className="font-display text-3xl font-extrabold uppercase">{last.reps === 1 ? "pushup" : "pushups"}</p>
        </div>

        <div className="dot-matrix flex items-baseline justify-between rounded-xl border border-line bg-panel px-4 py-3">
          <span className="font-mono text-xs tracking-[0.2em] text-mute uppercase">Personal best</span>
          <span className="font-display text-4xl leading-none font-black tabular-nums">{best}</span>
        </div>

        <div className="flex flex-col gap-3">
          <Button onClick={again}>Go again</Button>
          <ButtonLink to="/" variant="secondary">
            Done
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
