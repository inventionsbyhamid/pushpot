import { Link } from "react-router";
import { DONTS, DOS, type Tip } from "./content";
import { CheckIcon, CrossIcon } from "./icons";

/** The form rules the counter checks, compact enough for the card before a set. */
export function WorkoutPrep() {
  return (
    <section aria-label="Form check" className="rounded-xl border border-line bg-panel px-4 py-3.5">
      <div className="grid grid-cols-2 gap-4">
        <Rules title="Do" tips={DOS.slice(0, 3)} good />
        <Rules title="Don't" tips={DONTS.slice(0, 3)} />
      </div>
      <Link
        to="/guide"
        className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-volt underline underline-offset-4"
      >
        Full guide to the perfect rep
      </Link>
    </section>
  );
}

function Rules({ title, tips, good = false }: { title: string; tips: Tip[]; good?: boolean }) {
  return (
    <div>
      <h2 className={`font-display text-xl font-extrabold uppercase ${good ? "text-volt" : "text-flare"}`}>
        {title}
      </h2>
      <ul className="mt-1.5 space-y-1.5 text-sm leading-snug">
        {tips.map((tip) => (
          <li key={tip.title} className="flex gap-1.5">
            {good ? (
              <CheckIcon className="mt-px size-4 shrink-0 text-volt" />
            ) : (
              <CrossIcon className="mt-px size-4 shrink-0 text-flare" />
            )}
            {tip.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
