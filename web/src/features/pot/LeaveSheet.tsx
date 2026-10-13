import { useQueryClient } from "@tanstack/react-query";
import { TxSheet } from "../../components/TxSheet";
import { useTxFlow } from "../../hooks/useTxFlow";
import { potKeys } from "../../lib/queries";
import { leavePot } from "../../lib/stake";
import type { Pot } from "../../lib/types";
import { useChainPot } from "./useChainPot";

interface LeaveSheetProps {
  pot: Pot;
  open: boolean;
  onClose: () => void;
}

export function LeaveSheet({ pot, open, onClose }: LeaveSheetProps) {
  const queryClient = useQueryClient();
  const flow = useTxFlow();
  const chainPot = useChainPot(pot.id, open);

  const confirm = async () => {
    const result = await flow.run((report) => leavePot(BigInt(pot.id), report));
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
      title="Leave pot"
      amount={chainPot.data?.stake}
      amountLabel="You get back"
      pays={false}
      confirmLabel="Leave and get refund"
      flow={flow.state}
      onConfirm={confirm}
      amountError={
        chainPot.isError ? "Couldn't read the stake from Arc. Close and try again." : undefined
      }
    />
  );
}
