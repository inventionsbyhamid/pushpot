import type { Cadence } from "../../lib/types";

export const cadences: { id: Cadence; label: string; schedule: string }[] = [
  { id: "daily", label: "Daily", schedule: "New ones open every day at 00:00 UTC." },
  { id: "weekly", label: "Weekly", schedule: "New ones start every Monday." },
  { id: "weekend", label: "Weekend", schedule: "The next one starts on Saturday." },
  { id: "monthly", label: "Monthly", schedule: "The next one starts on the 1st." },
  {
    id: "yearly",
    label: "Yearly",
    schedule: "A new group starts on the first Monday of each month.",
  },
];

const STORAGE_KEY = "pushpot:challenge-cadence";

function isCadence(value: unknown): value is Cadence {
  return cadences.some((c) => c.id === value);
}

/** The last tab the viewer picked; storage can be missing or blocked, so it's only a hint. */
export function storedCadence(): Cadence {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isCadence(value) ? value : "daily";
  } catch {
    return "daily";
  }
}

export function storeCadence(cadence: Cadence): void {
  try {
    localStorage.setItem(STORAGE_KEY, cadence);
  } catch {
    // Private browsing or storage disabled: the choice just isn't remembered.
  }
}
