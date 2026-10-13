import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAccount, useReadContract } from "wagmi";
import { Button } from "../../components/Button";
import { Spinner } from "../../components/Spinner";
import { pushPotAbi } from "../../lib/abi";
import { useAuth } from "../../lib/auth";
import { chain, pushPotAddress } from "../../lib/config";
import { formatDuration, formatUsdc } from "../../lib/format";
import { isDaily, type MemberState, type PotClock } from "../../lib/pot";
import type { Member, Pot } from "../../lib/types";
import { ClaimSheet } from "./ClaimSheet";
import { JoinSheet } from "./JoinSheet";
import { LeaveSheet } from "./LeaveSheet";

interface PotActionBarProps {
  pot: Pot;
  clock: PotClock;
  now: number;
  me: Member | null;
  meState: MemberState | null;
}

type SheetId = "join" | "leave" | "claim";

export function PotActionBar({ pot, clock, now, me, meState }: PotActionBarProps) {
  const navigate = useNavigate();
  const auth = useAuth();
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const [wantsWorkout, setWantsWorkout] = useState(false);
  const [claimed, setClaimed] = useState<bigint | null>(null);

  const claimable = useReadContract({
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "claimable",
    args: address ? [BigInt(pot.id), address] : undefined,
    query: { enabled: clock.phase === "ended" && !!me && !!address },
  });

  const workoutPath = `/p/${pot.id}/workout`;
  useEffect(() => {
    if (wantsWorkout && auth.status === "authenticated") navigate(workoutPath);
  }, [wantsWorkout, auth.status, navigate, workoutPath]);

  const startWorkout = () => {
    if (auth.status === "authenticated") {
      navigate(workoutPath);
      return;
    }
    setWantsWorkout(true);
    openConnectModal?.();
  };

  const daily = isDaily(pot);
  const timeUntil = (at: number | null) => formatDuration(((at ?? now) - now) / 1000);
  let content: ReactNode;

  if (clock.phase === "upcoming") {
    if (me) {
      content = (
        <Status
          title={`Starts in ${timeUntil(clock.startsAt)}`}
          detail="You're in. Leave before the start for a full refund."
          action={
            <Button
              variant="secondary"
              className="min-h-11 text-lg"
              onClick={() => setSheet("leave")}
            >
              Leave
            </Button>
          }
        />
      );
    } else if (pot.member_count >= pot.max_members) {
      content = (
        <Status title="Pot is full" detail="Every spot is taken. Start your own pot instead." />
      );
    } else {
      content = (
        <Button
          className="min-h-14 w-full text-2xl"
          onClick={() => (isConnected ? setSheet("join") : openConnectModal?.())}
        >
          Join for {formatUsdc(pot.stake)}
        </Button>
      );
    }
  } else if (clock.phase === "active") {
    const lastPeriod = (clock.period ?? 0) + 1 === pot.periods;
    if (!isConnected) {
      content = (
        <Button
          variant="secondary"
          className="min-h-14 w-full text-2xl"
          onClick={() => openConnectModal?.()}
        >
          Connect to check in
        </Button>
      );
    } else if (!me) {
      content = <Status title="Joining closed" detail="This pot already started. Cheer them on." />;
    } else if (meState === "out") {
      content = (
        <Status
          title="You're out 💀"
          detail="You missed a deadline. Your stake goes to the finishers."
        />
      );
    } else if (meState === "done") {
      content = (
        <Status
          title={daily ? "Done for today ✅" : "Done for this round ✅"}
          detail={
            lastPeriod
              ? `That was the last one. Claims open in ${timeUntil(clock.claimsOpenAt)}.`
              : `Next ${daily ? "day" : "round"} starts in ${timeUntil(clock.periodEndsAt)}.`
          }
        />
      );
    } else {
      content = (
        <>
          <p className="mb-2 text-center text-sm text-amber">
            {daily ? "Today" : "This round"} ends in {timeUntil(clock.periodEndsAt)}
          </p>
          <Button className="min-h-14 w-full text-2xl" onClick={startWorkout}>
            {daily ? "Do today's" : "Do this round's"} {pot.reps_per_period} pushups
          </Button>
        </>
      );
    }
  } else if (clock.phase === "settling") {
    content = (
      <Status
        title={`Claims open in ${timeUntil(clock.claimsOpenAt)}`}
        detail="Late check-ins can still land for a few minutes after the end."
      />
    );
  } else if (!me) {
    content = isConnected ? (
      <Status title="This pot has ended" />
    ) : (
      <Button
        variant="secondary"
        className="min-h-14 w-full text-2xl"
        onClick={() => openConnectModal?.()}
      >
        Connect to claim
      </Button>
    );
  } else {
    const paid = claimed ?? (me.claimed_amount === null ? null : BigInt(me.claimed_amount));
    if (paid !== null) {
      content = <Status title={`Claimed ${formatUsdc(paid)} ✅`} detail="It's in your wallet." />;
    } else if (claimable.isPending) {
      content = <Status title="Checking your payout" action={<Spinner />} />;
    } else if (claimable.isError) {
      content = (
        <Status
          title="Couldn't read your payout"
          action={
            <Button
              variant="secondary"
              className="min-h-11 text-lg"
              onClick={() => void claimable.refetch()}
            >
              Retry
            </Button>
          }
        />
      );
    } else if (claimable.data > 0n) {
      content = (
        <Button className="min-h-14 w-full text-2xl" onClick={() => setSheet("claim")}>
          Claim {formatUsdc(claimable.data)}
        </Button>
      );
    } else {
      content = (
        <Status
          title="Nothing to claim"
          detail={
            meState === "out"
              ? "You missed a deadline, so your stake went to the finishers."
              : undefined
          }
        />
      );
    }
  }

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-ink/95 backdrop-blur-md">
        <div className="mx-auto max-w-md px-4 pt-3 pb-safe">{content}</div>
      </div>

      <JoinSheet pot={pot} open={sheet === "join"} onClose={() => setSheet(null)} />
      <LeaveSheet pot={pot} open={sheet === "leave"} onClose={() => setSheet(null)} />
      <ClaimSheet
        pot={pot}
        amount={claimable.data}
        open={sheet === "claim"}
        onClose={() => setSheet(null)}
        onClaimed={setClaimed}
      />
    </>
  );
}

function Status({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-14 items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-display text-2xl leading-tight font-extrabold">{title}</p>
        {detail && <p className="text-sm text-mute">{detail}</p>}
      </div>
      {action}
    </div>
  );
}
