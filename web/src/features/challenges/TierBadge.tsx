import type { Tier } from "../../lib/types";

const tiers: Record<Tier, { label: string; level: number; className: string }> = {
  rookie: { label: "Rookie", level: 1, className: "text-volt" },
  regular: { label: "Regular", level: 2, className: "text-amber" },
  beast: { label: "Beast", level: 3, className: "text-flare" },
};

/** Difficulty as one to three chalk tallies, in the tier's colour. */
export function TierBadge({ tier }: { tier: Tier }) {
  // Tolerate a tier this build doesn't know yet rather than break the whole list.
  const style = tiers[tier] ?? tiers.regular;
  return (
    <span
      className={`inline-flex items-center gap-2 font-display text-lg leading-none font-extrabold ${style.className}`}
    >
      <span aria-hidden className="flex gap-[3px]">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`h-3.5 w-1.5 -skew-x-12 rounded-[1px] ${n <= style.level ? "bg-current" : "bg-line"}`}
          />
        ))}
      </span>
      {style.label}
      <span className="sr-only"> tier</span>
      {tier === "beast" && <Flame />}
    </span>
  );
}

function Flame() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 16"
      className="-ml-0.5 h-4 w-3 origin-bottom fill-current motion-safe:animate-flicker"
    >
      <path d="M6.4 0c.3 2.6 4.6 4.4 4.6 9.2A5 5 0 0 1 1 9.4c0-2.2 1-3.6 2.3-4.6-.1 1.6.5 2.7 1.5 3C4.3 5.4 4.6 2.4 6.4 0Z" />
    </svg>
  );
}
