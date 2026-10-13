import { Link, useNavigate } from "react-router";
import { buttonClass, type ButtonVariant } from "../../components/Button";
import { describeError } from "../../lib/errors";
import { formatDuration, formatUsdc } from "../../lib/format";
import { planLabel, potCountdown, potTotal, type PotClock } from "../../lib/pot";
import { useOpenChallenge } from "../../lib/queries";
import { toast } from "../../lib/toast";
import type { Challenge } from "../../lib/types";
import { TierBadge } from "./TierBadge";

const URGENT_SECONDS = 3_600;

function callToAction(
  joined: boolean,
  open: boolean,
  full: boolean,
): { label: string; variant: ButtonVariant } {
  if (joined) return { label: "Open", variant: "primary" };
  if (open && !full) return { label: "Join", variant: "primary" };
  return { label: open ? "Full" : "Watch", variant: "secondary" };
}

interface ChallengeCardProps {
  challenge: Challenge;
  clock: PotClock;
  now: number;
  /** The viewer is already a member. */
  joined: boolean;
  /** Position in the list, to stagger the entrance. */
  index: number;
}

export function ChallengeCard({ challenge, clock, now, joined, index }: ChallengeCardProps) {
  const { pot, plan, template } = challenge;
  const navigate = useNavigate();
  const opening = useOpenChallenge();
  const members = pot?.member_count ?? 0;
  const upcoming = clock.phase === "upcoming";
  const full = members >= plan.max_members;
  const joinable = upcoming && !full && !joined;
  const total = potTotal({ stake: plan.stake, member_count: members });
  const countdown = potCountdown(plan, clock, now, { joining: true });
  const seconds = countdown.seconds ?? 0;
  const timerTone = !upcoming
    ? "text-volt"
    : seconds < URGENT_SECONDS
      ? "text-flare"
      : "text-amber";
  const cta = opening.isPending
    ? { label: "Opening", variant: "primary" as const }
    : callToAction(joined, upcoming, full);
  const cover = "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none";

  // The challenge goes on chain only once someone wants in, then they land on its join sheet.
  const open = () =>
    opening.mutate(challenge, {
      onSuccess: (id) => navigate(`/p/${id}?join=1`),
      onError: (error) => toast(`Couldn't open this challenge. ${describeError(error)}`, "error"),
    });

  return (
    <li
      className="relative overflow-hidden rounded-2xl border border-line bg-panel transition-colors hover:border-mute active:bg-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-volt motion-safe:animate-rise"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <TierBadge tier={template.tier} />
          <div className="flex items-center gap-2 text-sm">
            {joined && (
              <span className="rounded bg-volt px-1.5 leading-5 font-bold text-ink">You're in</span>
            )}
            {members > 1 && <span className="font-semibold tabular-nums">{members} in</span>}
            {members === 0 && upcoming && <span className="text-mute">Be the first in</span>}
          </div>
        </div>
        <h3 className="mt-2 font-display text-[2.5rem] leading-[0.9] font-black">
          {/* The whole card is the control; the name is its accessible label. */}
          {pot ? (
            <Link to={`/p/${pot.id}${joinable ? "?join=1" : ""}`} className={cover}>
              {template.name}
            </Link>
          ) : (
            <button
              type="button"
              className={`${cover} cursor-pointer text-left disabled:cursor-wait`}
              disabled={opening.isPending || !joinable}
              onClick={open}
            >
              {template.name}
            </button>
          )}
        </h3>
        <p className="mt-1 text-mute">{template.tagline}</p>
        <p className="mt-2 text-lg font-semibold">{planLabel(plan, clock.phase === "active")}</p>
      </div>

      <dl className="grid grid-cols-2 border-t border-dashed border-line">
        <div className="border-r border-dashed border-line px-4 py-2.5">
          <dt className="text-sm text-mute">Stake</dt>
          <dd className="font-display text-2xl leading-tight font-black">
            {formatUsdc(plan.stake, { symbol: false })} <span className="text-base">USDC</span>
          </dd>
        </div>
        <div className="px-4 py-2.5">
          <dt className="text-sm text-mute">In the pot</dt>
          <dd className="font-display text-2xl leading-tight font-black text-volt">
            {formatUsdc(total, { symbol: false })} <span className="text-base text-chalk">USDC</span>
          </dd>
        </div>
      </dl>

      <div className="dot-matrix flex items-center justify-between gap-3 border-t border-line bg-ink px-4 py-3">
        <p role="timer" className="min-w-0">
          <span className="block text-sm text-mute">{countdown.label}</span>
          <span className={`font-display text-3xl leading-none font-black ${timerTone}`}>
            {formatDuration(seconds)}
          </span>
        </p>
        <span aria-hidden className={buttonClass(cta.variant, "min-h-11 shrink-0 px-6 text-xl")}>
          {cta.label}
        </span>
      </div>
    </li>
  );
}
