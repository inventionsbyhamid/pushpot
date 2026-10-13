import {
  BaseError,
  ContractFunctionRevertedError,
  InsufficientFundsError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import { ApiError } from "./api";

const contractErrors: Record<string, string> = {
  InvalidParams: "The contract rejected these settings. Check the start time and limits.",
  Paused: "New pots and joins are paused right now.",
  PotNotFound: "This pot doesn't exist on Arc.",
  PotFull: "This pot is full.",
  JoiningClosed: "Joining closed when the pot started.",
  AlreadyJoined: "You're already in this pot.",
  NotMember: "You're not in this pot.",
  NotEnded: "Claims open 5 minutes after the pot ends.",
  NothingToClaim: "There's nothing for you to claim.",
  ERC20InsufficientBalance: "Not enough USDC in your wallet.",
  ERC20InsufficientAllowance: "The USDC permit wasn't accepted. Try again.",
  SafeERC20FailedOperation: "The USDC transfer failed. Check your balance and try again.",
};

function revertReason(error: ContractFunctionRevertedError): string | undefined {
  const name = error.data?.errorName;
  if (name && name in contractErrors) return contractErrors[name];
  const reason = error.reason?.toLowerCase() ?? "";
  if (reason.includes("exceeds balance")) return contractErrors.ERC20InsufficientBalance;
  if (reason.includes("allowance")) return contractErrors.ERC20InsufficientAllowance;
  return error.reason ?? undefined;
}

function isUserRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === 4001 || code === "ACTION_REJECTED";
}

/** Turns wallet, contract and API failures into a sentence a person can act on. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;

  if (error instanceof BaseError) {
    if (error.walk(isUserRejection)) return "You cancelled the request in your wallet.";
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const reason = revertReason(reverted);
      if (reason) return reason;
    }
    if (error.walk((e) => e instanceof InsufficientFundsError)) {
      return "Not enough USDC to pay for gas.";
    }
    if (error.walk((e) => e instanceof WaitForTransactionReceiptTimeoutError)) {
      return "Arc hasn't confirmed this yet. Check the explorer before trying again.";
    }
    if (error.name === "ConnectorChainMismatchError" || error.name === "ChainMismatchError") {
      return "Your wallet is on a different network. Switch to Arc and try again.";
    }
    return error.shortMessage;
  }

  if (isUserRejection(error)) return "You cancelled the request in your wallet.";
  if (error instanceof TypeError) return "Network error. Check your connection and try again.";
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}
