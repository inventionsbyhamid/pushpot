import { useReadContract } from "wagmi";
import { pushPotAbi } from "../../lib/abi";
import { chain, pushPotAddress } from "../../lib/config";

/** The pot as the contract reports it, for the terms a user signs against; never the API's copy. */
export function useChainPot(potId: number, enabled: boolean) {
  return useReadContract({
    chainId: chain.id,
    address: pushPotAddress,
    abi: pushPotAbi,
    functionName: "getPot",
    args: [BigInt(potId)],
    query: { enabled },
  });
}
