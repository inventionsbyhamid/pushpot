import { useReadContract } from "wagmi";
import { pushPotAbi } from "../../lib/abi";
import { chain, pushPotAddress } from "../../lib/config";

/** The pot's stake as the contract reports it; never the API's copy. */
export function usePotStake(potId: number, enabled: boolean) {
  return useReadContract({
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "getPot",
    args: [BigInt(potId)],
    query: { enabled, select: (pot) => pot.stake },
  });
}
