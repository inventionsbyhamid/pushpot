import { DetailRow } from "../../components/DetailRow";
import { FeeNote } from "../../components/FeeNote";
import { formatDateTime, formatDuration, formatUsdc } from "../../lib/format";
import { lengthLabel, periodUnit, planLabel } from "../../lib/pot";

interface CreateSummaryProps {
  title: string;
  reps: number | null;
  periods: number;
  periodSeconds: number;
  stake: bigint;
  startsAt: number | null;
  maxMembers: number;
  /** From the contract; undefined while loading. */
  feeBps: number | undefined;
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
  feeBps,
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
        <p className="text-mute">{reps === null ? lengthLabel(schedule) : planLabel(schedule)}</p>
      </div>

      <dl className="space-y-1.5 border-t border-dashed border-line px-4 py-3 text-sm">
        <DetailRow term="Starts">
          {startsAt === null
            ? "Pick a start time"
            : `${formatDateTime(startsAt)} (in ${formatDuration((startsAt - now) / 1000)})`}
        </DetailRow>
        <DetailRow term="Ends">{endsAt === null ? "Not set" : formatDateTime(endsAt)}</DetailRow>
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
          Friends can join until it starts. Finish every {periodUnit(schedule)} to split the pot.
        </p>
        <FeeNote feeBps={feeBps} className="mt-1" />
      </div>
    </section>
  );
}
