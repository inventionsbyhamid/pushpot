import type { PotPhase } from "../lib/pot";

const styles: Record<PotPhase, { label: string; className: string }> = {
  upcoming: { label: "Upcoming", className: "border-amber/50 text-amber" },
  active: { label: "Live", className: "border-volt/50 text-volt" },
  settling: { label: "Ended", className: "border-line text-mute" },
  ended: { label: "Ended", className: "border-line text-mute" },
};

export function StatusBadge({ phase }: { phase: PotPhase }) {
  const { label, className } = styles[phase];
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-sm font-semibold ${className}`}
    >
      {phase === "active" && (
        <span aria-hidden className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-volt opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-volt" />
        </span>
      )}
      {label}
    </span>
  );
}
