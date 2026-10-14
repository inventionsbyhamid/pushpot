import {
  isAddressEqual,
  parseEventLogs,
  parseSignature,
  WaitForTransactionReceiptTimeoutError,
  type Address,
  type Hash,
  type TransactionReceipt,
} from "viem";
import {
  getAccount,
  getTransactionReceipt,
  readContract,
  signTypedData,
  simulateContract,
  writeContract,
} from "wagmi/actions";
import { pushPotAbi } from "./abi";
import { chain, pushPotAddress, trustedOracle, usdcAddress } from "./config";
import { formatUsdc } from "./format";
import { GAS_HEADROOM, usdcAbi } from "./usdc";
import { wagmiConfig } from "./wagmi";

const PERMIT_TTL_SECONDS = 60 * 60;
const RECEIPT_TIMEOUT_MS = 90_000;
/** Arc confirms in about a second, so asking for the receipt beats watching blocks for it. */
const RECEIPT_POLL_MS = 500;

export type TxStep = "sign" | "send" | "confirm";
export type ReportStep = (step: TxStep, hash?: Hash) => void;

export interface TxOutcome {
  hash: Hash;
  confirmMs: number;
}

export interface NewPotParams {
  title: string;
  stake: bigint;
  repsPerPeriod: number;
  periods: number;
  periodSeconds: number;
  startTime: bigint;
  maxMembers: number;
}

export class InsufficientUsdcError extends Error {
  constructor(
    readonly needed: bigint,
    readonly balance: bigint,
  ) {
    super(`You need ${formatUsdc(needed)} including gas. Your wallet has ${formatUsdc(balance)}.`);
  }
}

export class TxRevertedError extends Error {
  constructor(readonly hash: Hash) {
    super("The transaction failed on Arc.");
  }
}

function connectedOnArc(): Address {
  const { address, chainId } = getAccount(wagmiConfig);
  if (!address) throw new Error("Connect your wallet first.");
  if (chainId !== chain.id) throw new Error(`Switch your wallet to ${chain.name} first.`);
  return address;
}

export function readUsdcBalance(owner: Address): Promise<bigint> {
  return readContract(wagmiConfig, {
    chainId: chain.id,
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [owner],
  });
}

function readPot(potId: bigint) {
  return readContract(wagmiConfig, {
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "getPot",
    args: [potId],
  });
}

/** The terms a user reviewed before joining. */
export interface JoinTerms {
  stake: bigint;
  repsPerPeriod: number;
  periods: number;
  periodSeconds: number;
  /** Unix seconds. */
  startTime: number;
  /** Platform fee on forfeited stakes, in basis points. */
  feeBps: number;
}

function ensureFunds(balance: bigint, stake: bigint): void {
  const needed = stake + GAS_HEADROOM;
  if (balance < needed) throw new InsufficientUsdcError(needed, balance);
}

/** EIP-2612 permit for exactly `value`, spendable only by the PushPot contract. */
async function signPermit(owner: Address, value: bigint) {
  const read = { chainId: chain.id, address: usdcAddress, abi: usdcAbi } as const;
  const [name, version, nonce] = await Promise.all([
    readContract(wagmiConfig, { ...read, functionName: "name" }),
    readContract(wagmiConfig, { ...read, functionName: "version" }),
    readContract(wagmiConfig, { ...read, functionName: "nonces", args: [owner] }),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_TTL_SECONDS);
  const signature = await signTypedData(wagmiConfig, {
    account: owner,
    domain: { name, version, chainId: chain.id, verifyingContract: usdcAddress },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner, spender: pushPotAddress, value, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  return { deadline, v: Number(v ?? BigInt(yParity) + 27n), r, s };
}

async function confirm(
  hash: Hash,
  report: ReportStep,
): Promise<{ receipt: TransactionReceipt; confirmMs: number }> {
  report("confirm", hash);
  const sentAt = performance.now();
  const receipt = await pollReceipt(hash, sentAt + RECEIPT_TIMEOUT_MS);
  if (receipt.status !== "success") throw new TxRevertedError(hash);
  return { receipt, confirmMs: performance.now() - sentAt };
}

async function pollReceipt(hash: Hash, deadline: number): Promise<TransactionReceipt> {
  while (performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
    try {
      return await getTransactionReceipt(wagmiConfig, { chainId: chain.id, hash });
    } catch {
      // Not mined yet, or no RPC answered this time; the next poll may find it.
    }
  }
  throw new WaitForTransactionReceiptTimeoutError({ hash });
}

function potLogs(receipt: TransactionReceipt) {
  return receipt.logs.filter((log) => isAddressEqual(log.address, pushPotAddress));
}

class UntrustedOracleError extends Error {
  constructor() {
    super("This pot isn't judged by PushPot's oracle, so the app won't stake money in it.");
  }
}

function readOracle(): Promise<Address> {
  return readContract(wagmiConfig, {
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "oracle",
  });
}

function readFeeBps(): Promise<number> {
  return readContract(wagmiConfig, {
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "feeBps",
  });
}

/** A new pot takes the contract's current fee, so it must still be the one the user reviewed. */
export async function createPot(
  params: NewPotParams,
  feeBps: number,
  report: ReportStep,
): Promise<TxOutcome & { potId: bigint }> {
  const owner = connectedOnArc();
  // Read together, these go out as one multicall.
  const [oracle, currentFeeBps, balance] = await Promise.all([
    readOracle(),
    readFeeBps(),
    readUsdcBalance(owner),
  ]);
  // A new pot is bound to whichever oracle the contract names right now.
  if (!isAddressEqual(oracle, trustedOracle)) throw new UntrustedOracleError();
  if (currentFeeBps !== feeBps) {
    throw new Error("PushPot's fee changed since you loaded this page. Reload and review it.");
  }
  ensureFunds(balance, params.stake);

  report("sign");
  const permit = await signPermit(owner, params.stake);
  const { request } = await simulateContract(wagmiConfig, {
    chainId: chain.id,
    account: owner,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "createPotWithPermit",
    args: [params, permit.deadline, permit.v, permit.r, permit.s],
  });

  report("send");
  const hash = await writeContract(wagmiConfig, request);
  const { receipt, confirmMs } = await confirm(hash, report);
  const [created] = parseEventLogs({
    abi: pushPotAbi,
    eventName: "PotCreated",
    logs: potLogs(receipt),
  });
  if (!created) throw new Error("The pot was created, but its id is missing from the receipt.");
  return { hash, confirmMs, potId: created.args.potId };
}

/**
 * Every term the user reviewed is re-read from the contract and must match before anything is
 * signed, so a stale or tampered API response can't misstate what they're joining.
 */
export async function joinPot(
  potId: bigint,
  terms: JoinTerms,
  report: ReportStep,
): Promise<TxOutcome> {
  const owner = connectedOnArc();
  const [pot, balance] = await Promise.all([readPot(potId), readUsdcBalance(owner)]);
  if (!isAddressEqual(pot.oracle, trustedOracle)) throw new UntrustedOracleError();
  const matches =
    pot.stake === terms.stake &&
    pot.repsPerPeriod === terms.repsPerPeriod &&
    pot.periods === terms.periods &&
    pot.periodSeconds === terms.periodSeconds &&
    pot.startTime === BigInt(terms.startTime) &&
    pot.feeBps === terms.feeBps;
  if (!matches) {
    throw new Error(
      "This pot's terms on Arc differ from what's shown. Reload the page and review them.",
    );
  }
  const stake = pot.stake;
  ensureFunds(balance, stake);

  report("sign");
  const permit = await signPermit(owner, stake);
  const { request } = await simulateContract(wagmiConfig, {
    chainId: chain.id,
    account: owner,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "joinWithPermit",
    args: [potId, permit.deadline, permit.v, permit.r, permit.s],
  });

  report("send");
  const hash = await writeContract(wagmiConfig, request);
  const { confirmMs } = await confirm(hash, report);
  return { hash, confirmMs };
}

export async function leavePot(potId: bigint, report: ReportStep): Promise<TxOutcome> {
  const owner = connectedOnArc();
  const { request } = await simulateContract(wagmiConfig, {
    chainId: chain.id,
    account: owner,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "leave",
    args: [potId],
  });

  report("send");
  const hash = await writeContract(wagmiConfig, request);
  const { confirmMs } = await confirm(hash, report);
  return { hash, confirmMs };
}

export async function claimPot(
  potId: bigint,
  report: ReportStep,
): Promise<TxOutcome & { amount: bigint | null }> {
  const owner = connectedOnArc();
  const { request } = await simulateContract(wagmiConfig, {
    chainId: chain.id,
    account: owner,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "claim",
    args: [potId],
  });

  report("send");
  const hash = await writeContract(wagmiConfig, request);
  const { receipt, confirmMs } = await confirm(hash, report);
  const [claimed] = parseEventLogs({
    abi: pushPotAbi,
    eventName: "Claimed",
    logs: potLogs(receipt),
  });
  return { hash, confirmMs, amount: claimed?.args.amount ?? null };
}
