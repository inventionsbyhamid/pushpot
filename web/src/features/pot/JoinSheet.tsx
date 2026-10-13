import { useQueryClient } from "@tanstack/react-query";
import { FeeNote } from "../../components/FeeNote";
import { TxSheet } from "../../components/TxSheet";
import { useTxFlow } from "../../hooks/useTxFlow";
import { potKeys } from "../../lib/queries";
import { joinPot } from "../../lib/stake";
import type { Pot } from "../../lib/types";
import { useChainPot } from "./useChainPot";

interface JoinSheetProps {
  pot: Pot;
  open: boolean;
  onClose: () => void;
}

export function JoinSheet({ pot, open, onClose }: JoinSheetProps) {
  const queryClient = useQueryClient();
  const flow = useTxFlow();
  const chainPot = useChainPot(pot.id, open);

  const confirm = async () => {
    if (chainPot.data === undefined) return;
    const terms = {
      stake: chainPot.data.stake,
      repsPerPeriod: pot.reps_per_period,
      periods: pot.periods,
      periodSeconds: pot.period_seconds,
      startTime: Math.round(Date.parse(pot.start_time) / 1000),
      feeBps: chainPot.data.feeBps,
    };
    const result = await flow.run((report) => joinPot(BigInt(pot.id), terms, report));
    if (!result) return;
    void queryClient.invalidateQueries({ queryKey: potKeys.detail(pot.id) });
    // Member counts in "Your pots" and the challenge list change too.
    void queryClient.invalidateQueries({ queryKey: potKeys.lists });
  };

  return (
    <TxSheet
      open={open}
      onClose={() => {
        onClose();
        flow.reset();
      }}
      title={`Join ${pot.title}`}
      amount={chainPot.data?.stake}
      amountLabel="You stake"
      pays
      confirmLabel="Sign and join"
      flow={flow.state}
      onConfirm={confirm}
      amountError={
        chainPot.isError ? "Couldn't read this pot from Arc. Close and try again." : undefined
      }
    >
      <div className="space-y-2">
        <FeeNote feeBps={chainPot.data?.feeBps} />
        <p className="text-sm text-mute">
          The stake and fee come straight from the contract. You'll sign a permit for exactly that
          amount, then confirm one transaction. You can leave for a full refund until the pot
          starts.
        </p>
      </div>
    </TxSheet>
  );
}
