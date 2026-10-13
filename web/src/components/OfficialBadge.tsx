import { TallyIcon } from "./Wordmark";

/** Marks a challenge opened by PushPot itself, stamped with the logo's tally. */
export function OfficialBadge() {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-chalk px-2.5 text-sm font-semibold text-ink">
      <TallyIcon className="h-3.5 w-4" />
      Official challenge
    </span>
  );
}
