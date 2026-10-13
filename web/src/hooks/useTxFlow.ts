import { useCallback, useState } from "react";
import type { Hash } from "viem";
import { describeError } from "../lib/errors";
import type { ReportStep, TxOutcome, TxStep } from "../lib/stake";

export type FlowStep = "prepare" | TxStep;

export type TxFlowState =
  | { status: "idle" }
  | { status: "running"; step: FlowStep; hash?: Hash }
  | { status: "success"; hash: Hash; confirmMs: number }
  | { status: "error"; step: FlowStep; hash?: Hash; message: string };

/** Runs a multi-step wallet flow and exposes its progress for `TxSteps`. */
export function useTxFlow() {
  const [state, setState] = useState<TxFlowState>({ status: "idle" });

  const run = useCallback(
    async <T extends TxOutcome>(task: (report: ReportStep) => Promise<T>): Promise<T | null> => {
      let step: FlowStep = "prepare";
      let hash: Hash | undefined;
      const report: ReportStep = (next, nextHash) => {
        step = next;
        hash = nextHash ?? hash;
        setState({ status: "running", step, hash });
      };

      setState({ status: "running", step });
      try {
        const result = await task(report);
        setState({ status: "success", hash: result.hash, confirmMs: result.confirmMs });
        return result;
      } catch (error) {
        setState({ status: "error", step, hash, message: describeError(error) });
        return null;
      }
    },
    [],
  );

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, run, reset };
}
