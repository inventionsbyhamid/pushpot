import { useQueryClient } from "@tanstack/react-query";
import { TxSheet } from "../../components/TxSheet";
import { useTxFlow } from "../../hooks/useTxFlow";
import { celebrate } from "../../lib/celebrate";
import { formatUsdc } from "../../lib/format";
import { potKeys } from "../../lib/queries";
import { claimPot } from "../../lib/stake";
import { toast } from "../../lib/toast";
import type { Pot } from "../../lib/types";

interface ClaimSheetProps {
  pot: Pot;
  /** From `claimable(potId, account)` on the contract. */
  amount: bigint | undefined;
  open: boolean;
  onClose: () => void;
  onClaimed: (amount: bigint) => void;
}

export function ClaimSheet({ pot, amount, open, onClose, onClaimed }: ClaimSheetProps) {
  const queryClient = useQueryClient();
  const flow = useTxFlow();

  const confirm = async () => {
    const result = await flow.run((report) => claimPot(BigInt(pot.id), report));
    if (!result) return;
    const received = result.amount ?? amount ?? 0n;
    celebrate();
    toast(`Claimed ${formatUsdc(received)}`, "success");
    onClaimed(received);
    void queryClient.invalidateQueries({ queryKey: potKeys.detail(pot.id) });
  };

  return (
    <TxSheet
      open={open}
      onClose={() => {
        onClose();
        flow.reset();
      }}
      title="Claim payout"
      amount={amount}
      amountLabel="You receive"
      pays={false}
      confirmLabel="Claim"
      flow={flow.state}
      onConfirm={confirm}
    />
  );
}
