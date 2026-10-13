import type { FlowStep, TxFlowState } from "../hooks/useTxFlow";
import { txUrl } from "../lib/config";
import { formatUsdc, shortHash } from "../lib/format";
import { ExternalLink } from "./ExternalLink";
import { Spinner } from "./Spinner";

type RowState = "todo" | "active" | "done" | "error";

const order: FlowStep[] = ["prepare", "sign", "send", "confirm"];

function rowState(row: FlowStep, rows: FlowStep[], state: TxFlowState): RowState {
  if (state.status === "success") return "done";
  if (state.status === "idle") return "todo";
  // The checks before the first wallet prompt belong to the first row.
  const current = state.step === "prepare" ? rows[0] : state.step;
  const at = order.indexOf(row);
  const now = order.indexOf(current ?? "prepare");
  if (at < now) return "done";
  if (at > now) return "todo";
  return state.status === "error" ? "error" : "active";
}

function RowIcon({ state }: { state: RowState }) {
  switch (state) {
    case "done":
      return (
        <span className="grid size-7 place-items-center rounded-full bg-volt text-sm font-bold text-ink">
          ✓
        </span>
      );
    case "active":
      return (
        <span className="grid size-7 place-items-center text-amber">
          <Spinner className="size-5" />
        </span>
      );
    case "error":
      return (
        <span className="grid size-7 place-items-center rounded-full bg-flare text-sm font-bold text-ink">
          !
        </span>
      );
    case "todo":
      return <span className="size-7 rounded-full border-2 border-line" />;
  }
}

interface TxStepsProps {
  state: TxFlowState;
  /** Set for flows that sign a USDC permit before the transaction. */
  permitAmount?: bigint;
}

export function TxSteps({ state, permitAmount }: TxStepsProps) {
  const rows: FlowStep[] =
    permitAmount === undefined ? ["send", "confirm"] : ["sign", "send", "confirm"];
  const labels: Record<FlowStep, string> = {
    prepare: "",
    sign: permitAmount === undefined ? "" : `Sign permit for ${formatUsdc(permitAmount)}`,
    send: "Confirm transaction",
    confirm:
      state.status === "success"
        ? `Confirmed in ${(state.confirmMs / 1000).toFixed(1)}s`
        : "Record on Arc",
  };
  const hash = state.status === "idle" ? undefined : state.hash;

  return (
    <div className="space-y-3">
      <ol className="space-y-2.5">
        {rows.map((row) => {
          const rs = rowState(row, rows, state);
          return (
            <li key={row} className="flex min-h-8 items-center gap-3">
              <RowIcon state={rs} />
              <span
                className={
                  rs === "todo"
                    ? "text-mute"
                    : rs === "done" && row === "confirm"
                      ? "font-semibold text-volt"
                      : "text-chalk"
                }
              >
                {labels[row]}
              </span>
            </li>
          );
        })}
      </ol>
      {state.status === "error" && (
        <p
          role="alert"
          className="rounded-lg border border-flare/40 bg-flare/10 px-3 py-2.5 text-sm text-chalk"
        >
          {state.message}
        </p>
      )}
      {hash && (
        <p className="text-sm text-mute">
          Transaction{" "}
          <ExternalLink href={txUrl(hash)} className="font-mono text-chalk">
            {shortHash(hash)}
          </ExternalLink>
        </p>
      )}
    </div>
  );
}
