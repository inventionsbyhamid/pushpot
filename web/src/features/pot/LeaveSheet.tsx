import { useQueryClient } from "@tanstack/react-query";
import { TxSheet } from "../../components/TxSheet";
import { useTxFlow } from "../../hooks/useTxFlow";
import { potKeys } from "../../lib/queries";
import { leavePot } from "../../lib/stake";
import type { Pot } from "../../lib/types";
import { usePotStake } from "./usePotStake";

interface LeaveSheetProps {
  pot: Pot;
  open: boolean;
  onClose: () => void;
}

export function LeaveSheet({ pot, open, onClose }: LeaveSheetProps) {
  const queryClient = useQueryClient();
  const flow = useTxFlow();
  const stake = usePotStake(pot.id, open);

  const confirm = async () => {
    const result = await flow.run((report) => leavePot(BigInt(pot.id), report));
    if (result) void queryClient.invalidateQueries({ queryKey: potKeys.detail(pot.id) });
  };

  return (
    <TxSheet
      open={open}
      onClose={() => {
        onClose();
        flow.reset();
      }}
      title="Leave pot"
      amount={stake.data}
      amountLabel="You get back"
      pays={false}
      confirmLabel="Leave and get refund"
      flow={flow.state}
      onConfirm={confirm}
      amountError={
        stake.isError ? "Couldn't read the stake from Arc. Close and try again." : undefined
      }
    />
  );
}
