import { ButtonLink } from "../../components/Button";
import { ExternalLink } from "../../components/ExternalLink";
import { ScoreDigits } from "../../components/ScoreDigits";
import { txUrl } from "../../lib/config";
import { shortHash } from "../../lib/format";
import type { RecordedWorkout } from "../../lib/types";

interface CheckInRecordedProps {
  potId: number;
  result: RecordedWorkout;
  reps: number;
  periodLabel: string;
}

export function CheckInRecorded({ potId, result, reps, periodLabel }: CheckInRecordedProps) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 pt-6">
        <p className="text-lg">
          {reps} pushups for {periodLabel} <span aria-hidden>✅</span>
        </p>
        <h1 className="mt-6 font-display text-4xl leading-none font-extrabold">
          Recorded on Arc in
        </h1>
        <p className="font-display text-[8rem] leading-[0.85] font-black text-volt glow-volt">
          <ScoreDigits value={(result.latency_ms / 1000).toFixed(1)} />
          <span className="text-6xl">s</span>
        </p>
        <p className="mt-6 text-mute">
          Transaction{" "}
          <ExternalLink href={txUrl(result.tx_hash)} className="font-mono text-chalk">
            {shortHash(result.tx_hash)}
          </ExternalLink>
        </p>
      </div>
      <ButtonLink to={`/p/${potId}`} className="mb-4 min-h-14 w-full text-2xl">
        Back to pot
      </ButtonLink>
    </div>
  );
}
