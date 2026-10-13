import { DetailRow } from "../../components/DetailRow";
import { formatDateTime, formatDuration, formatUsdc } from "../../lib/format";
import { cadenceLabel, isDaily, lengthLabel } from "../../lib/pot";

interface CreateSummaryProps {
  title: string;
  reps: number | null;
  periods: number;
  periodSeconds: number;
  stake: bigint;
  startsAt: number | null;
  maxMembers: number;
  now: number;
}

export function CreateSummary({
  title,
  reps,
  periods,
  periodSeconds,
  stake,
  startsAt,
  maxMembers,
  now,
}: CreateSummaryProps) {
  const schedule = { reps_per_period: reps ?? 0, period_seconds: periodSeconds, periods };
  const endsAt = startsAt === null ? null : startsAt + periods * periodSeconds * 1000;

  return (
    <section
      aria-label="Summary"
      className="overflow-hidden rounded-2xl border border-line bg-panel"
    >
      <div className="px-4 pt-4 pb-3">
        <p
          className={`truncate font-display text-3xl leading-tight font-extrabold ${title ? "" : "text-mute"}`}
        >
          {title || "Your pot"}
        </p>
        <p className="text-mute">
          {reps === null
            ? lengthLabel(schedule)
            : `${cadenceLabel(schedule)}, ${lengthLabel(schedule)}`}
        </p>
      </div>

      <dl className="space-y-1.5 border-t border-dashed border-line px-4 py-3 text-sm">
        <DetailRow term="Starts">
          {startsAt === null
            ? "–"
            : `${formatDateTime(startsAt)} (in ${formatDuration((startsAt - now) / 1000)})`}
        </DetailRow>
        <DetailRow term="Ends">{endsAt === null ? "–" : formatDateTime(endsAt)}</DetailRow>
        <DetailRow term="Each player stakes">{formatUsdc(stake)}</DetailRow>
        <DetailRow term={`Pot with ${maxMembers} players`}>
          {formatUsdc(stake * BigInt(maxMembers))}
        </DetailRow>
      </dl>

      <div className="dot-matrix border-t border-line bg-ink px-4 py-3">
        <p className="text-sm text-mute">You stake now</p>
        <p className="font-display text-5xl leading-none font-black text-volt glow-volt">
          {formatUsdc(stake, { symbol: false })}
          <span className="ml-2 text-2xl text-chalk [text-shadow:none]">USDC</span>
        </p>
        <p className="mt-2 text-sm text-mute">
          Friends can join until it starts. Finish every {isDaily(schedule) ? "day" : "round"} to
          split the pot.
        </p>
      </div>
    </section>
  );
}
