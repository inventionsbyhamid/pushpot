/** A chalk tally of five: every rep counts. */
export function TallyIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 20"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
    >
      <path d="M4 3v14M9 3v14M14 3v14M19 3v14M1.5 14.5 21.5 5.5" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <TallyIcon className="h-5 w-6 text-volt" />
      <span className="font-display text-[1.75rem] leading-none font-black tracking-tight uppercase">
        PushPot
      </span>
    </span>
  );
}
