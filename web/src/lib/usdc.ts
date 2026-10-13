import { erc20Abi, parseAbi } from "viem";

export const usdcAbi = [
  ...erc20Abi,
  ...parseAbi([
    "function version() view returns (string)",
    "function nonces(address owner) view returns (uint256)",
  ]),
] as const;

/** Gas on Arc is paid in USDC from the same balance, so stakes leave this much behind. */
export const GAS_HEADROOM = 10_000n;
