import { useQueryClient } from "@tanstack/react-query";
import { TxSheet } from "../../components/TxSheet";
import { useTxFlow } from "../../hooks/useTxFlow";
import { potKeys } from "../../lib/queries";
import { joinPot } from "../../lib/stake";
import type { Pot } from "../../lib/types";
import { usePotStake } from "./usePotStake";

interface JoinSheetProps {
  pot: Pot;
  open: boolean;
  onClose: () => void;
}

export function JoinSheet({ pot, open, onClose }: JoinSheetProps) {
  const queryClient = useQueryClient();
  const flow = useTxFlow();
  const stake = usePotStake(pot.id, open);

  const confirm = async () => {
    if (stake.data === undefined) return;
    const terms = {
      stake: stake.data,
      repsPerPeriod: pot.reps_per_period,
      periods: pot.periods,
      periodSeconds: pot.period_seconds,
      startTime: Math.round(Date.parse(pot.start_time) / 1000),
    };
    const result = await flow.run((report) => joinPot(BigInt(pot.id), terms, report));
    if (result) void queryClient.invalidateQueries({ queryKey: potKeys.detail(pot.id) });
  };

  return (
    <TxSheet
      open={open}
      onClose={() => {
        onClose();
        flow.reset();
      }}
      title={`Join ${pot.title}`}
      amount={stake.data}
      amountLabel="You stake"
      pays
      confirmLabel="Sign and join"
      flow={flow.state}
      onConfirm={confirm}
      amountError={
        stake.isError ? "Couldn't read the stake from Arc. Close and try again." : undefined
      }
    >
      <p className="text-sm text-mute">
        The stake amount comes straight from the contract. You'll sign a permit for exactly that
        amount, then confirm one transaction. You can leave for a full refund until the pot starts.
      </p>
    </TxSheet>
  );
}
