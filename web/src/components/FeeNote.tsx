import { formatBps } from "../lib/format";

interface FeeNoteProps {
  /** Read from the contract; undefined while loading. */
  feeBps: number | undefined;
  className?: string;
}

/** The platform fee terms in plain words. */
export function FeeNote({ feeBps, className = "" }: FeeNoteProps) {
  return <p className={`text-sm text-mute ${className}`}>{feeTerms(feeBps)}</p>;
}

function feeTerms(feeBps: number | undefined): string {
  if (feeBps === undefined) return "Reading the platform fee from Arc…";
  if (feeBps === 0) return "PushPot takes no fee on this pot.";
  return `PushPot keeps ${formatBps(feeBps)} of forfeited stakes. If everyone finishes, or nobody does, there's no fee.`;
}
