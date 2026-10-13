import { Button } from "../../components/Button";
import { WorkoutPrep } from "../guide/WorkoutPrep";
import { CloseIcon } from "./icons";

const TIPS = [
  { title: "Phone on the floor, landscape", detail: "Lean it against something about 2 m away." },
  { title: "Sideways to the camera", detail: "Your body should run across the screen." },
  { title: "Head to feet in frame", detail: "Hold a plank with straight arms to start counting." },
];

interface SessionIntroProps {
  target?: number;
  onStart: () => void;
  onExit?: () => void;
}

export function SessionIntro({ target, onStart, onExit }: SessionIntroProps) {
  return (
    <div className="absolute inset-0 overflow-y-auto bg-ink">
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-7 px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-safe">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs tracking-[0.2em] text-volt uppercase">
              {target === undefined ? "Practice" : `${target} pushups`}
            </p>
            <h1 className="mt-2 font-display text-5xl leading-[0.9] font-black uppercase">Set up your camera</h1>
          </div>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              aria-label="Close"
              className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded-full text-mute hover:text-chalk"
            >
              <CloseIcon />
            </button>
          )}
        </header>

        <ol className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {TIPS.map((tip, i) => (
            <li key={tip.title} className="flex gap-4 px-4 py-3.5">
              <span className="w-4 font-display text-3xl leading-none font-black text-volt">{i + 1}</span>
              <div>
                <p className="font-semibold">{tip.title}</p>
                <p className="text-sm text-mute">{tip.detail}</p>
              </div>
            </li>
          ))}
        </ol>

        <WorkoutPrep />

        <div className="flex flex-col gap-3">
          <Button onClick={onStart} className="w-full">
            Start
          </Button>
          <p className="text-center text-xs text-mute">Counted on your phone · no video leaves it</p>
        </div>
      </div>
    </div>
  );
}
