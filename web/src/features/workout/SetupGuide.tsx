import type { SetupChecks } from "../../pose/setup";

const CHECKS: { key: keyof SetupChecks; label: string }[] = [
  { key: "inFrame", label: "In frame" },
  { key: "plank", label: "Plank, arms straight" },
];

export function SetupGuide({ checks }: { checks: SetupChecks }) {
  const ready = CHECKS.every(({ key }) => checks[key]);
  return (
    <div className="rounded-xl border border-line bg-ink/85 px-4 py-3">
      <p className={`font-display text-2xl leading-none font-extrabold uppercase ${ready ? "text-volt" : "text-chalk"}`}>
        {ready ? "Hold it…" : "Get in position"}
      </p>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {CHECKS.map(({ key, label }) => (
          <li key={key} className={`flex items-center gap-2 text-sm ${checks[key] ? "text-volt" : "text-mute"}`}>
            <span
              aria-hidden
              className={`size-2.5 rounded-full ${checks[key] ? "bg-volt" : "border border-mute"}`}
            />
            {label}
            <span className="sr-only">{checks[key] ? "done" : "not yet"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
