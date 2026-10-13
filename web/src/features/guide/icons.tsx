const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function PlayIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="currentColor">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}

export function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6" {...stroke}>
      <path d={direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}

export function CheckIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} {...stroke} strokeWidth={3}>
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}

export function CrossIcon({ className = "size-5" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} {...stroke} strokeWidth={3}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
