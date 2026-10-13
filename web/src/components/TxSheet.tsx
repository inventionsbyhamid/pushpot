import { useEffect, type ReactNode } from "react";
import { useAccount, useReadContract, useSwitchChain } from "wagmi";
import type { TxFlowState } from "../hooks/useTxFlow";
import { addressUrl, chain, getUsdcUrl, pushPotAddress, usdcAddress } from "../lib/config";
import { describeError } from "../lib/errors";
import { formatUsdc, formatUsdcExact, shortAddress } from "../lib/format";
import { GAS_HEADROOM, usdcAbi } from "../lib/usdc";
import { Button } from "./Button";
import { DetailRow } from "./DetailRow";
import { ExternalLink } from "./ExternalLink";
import { Sheet } from "./Sheet";
import { Spinner } from "./Spinner";
import { TxSteps } from "./TxSteps";

interface TxSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Read from the chain by the caller; undefined while loading. */
  amount: bigint | undefined;
  amountLabel: string;
  /** The amount leaves the wallet through a USDC permit. */
  pays: boolean;
  confirmLabel: string;
  flow: TxFlowState;
  onConfirm: () => void;
  /** Shown instead of the confirm button when the amount can't be read. */
  amountError?: string;
  children?: ReactNode;
}

export function TxSheet({
  open,
  onClose,
  title,
  amount,
  amountLabel,
  pays,
  confirmLabel,
  flow,
  onConfirm,
  amountError,
  children,
}: TxSheetProps) {
  const { address, chainId } = useAccount();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const balance = useReadContract({
    chainId: chain.id,
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: open && !!address },
  });

  const { refetch: refetchBalance } = balance;
  useEffect(() => {
    if (flow.status === "success") void refetchBalance();
  }, [flow.status, refetchBalance]);

  const running = flow.status === "running";
  const wrongChain = chainId !== chain.id;
  const needed = (pays && amount !== undefined ? amount : 0n) + GAS_HEADROOM;
  const short =
    balance.data !== undefined && (!pays || amount !== undefined) && balance.data < needed;

  let action: ReactNode;
  if (flow.status === "success") {
    action = (
      <Button className="w-full" onClick={onClose}>
        Done
      </Button>
    );
  } else if (running) {
    action = (
      <Button className="w-full" disabled>
        <Spinner />
        {flow.step === "confirm" ? "Recording on Arc" : "Check your wallet"}
      </Button>
    );
  } else if (wrongChain) {
    action = (
      <>
        <Button
          className="w-full"
          disabled={switching}
          onClick={() => switchChain({ chainId: chain.id })}
        >
          {switching && <Spinner />}
          Switch to {chain.name}
        </Button>
        {switchError && <p className="text-sm text-flare">{describeError(switchError)}</p>}
      </>
    );
  } else if (amountError) {
    action = <p className="text-flare">{amountError}</p>;
  } else {
    const blocked = amount === undefined || balance.isPending || (pays && short);
    action = (
      <Button className="w-full" disabled={blocked} onClick={onConfirm}>
        {flow.status === "error" ? "Try again" : confirmLabel}
      </Button>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={title} dismissible={!running}>
      <div className="mt-3 space-y-5">
        <div className="dot-matrix rounded-xl border border-line bg-ink px-4 py-3">
          <p className="text-sm text-mute">{amountLabel}</p>
          <p className="font-display text-5xl leading-none font-black text-volt">
            {amount === undefined ? "…" : formatUsdc(amount, { symbol: false })}
            <span className="ml-2 text-2xl text-chalk">USDC</span>
          </p>
        </div>

        <dl className="space-y-1.5 text-sm">
          {pays && amount !== undefined && (
            <DetailRow term="Permit amount">
              <span className="font-mono">{formatUsdcExact(amount)}</span>
            </DetailRow>
          )}
          {pays && (
            <DetailRow term="Spender">
              <ExternalLink href={addressUrl(pushPotAddress)} className="font-mono">
                PushPot {shortAddress(pushPotAddress)}
              </ExternalLink>
            </DetailRow>
          )}
          <DetailRow term="Your balance">
            {balance.data === undefined ? "…" : formatUsdc(balance.data)}
          </DetailRow>
          <DetailRow term="Network fee">Under {formatUsdc(GAS_HEADROOM)}, paid in USDC</DetailRow>
        </dl>

        {children}

        {short && !running && flow.status !== "success" && (
          <p className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2.5 text-sm">
            {pays
              ? `You need ${formatUsdc(needed)} including gas.`
              : "You may not have enough USDC left to pay the network fee."}{" "}
            <ExternalLink href={getUsdcUrl}>Get USDC on Arc</ExternalLink>
          </p>
        )}

        <TxSteps state={flow} permitAmount={pays ? amount : undefined} />

        {action}
      </div>
    </Sheet>
  );
}
