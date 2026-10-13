import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { fallback, http } from "wagmi";
import { chain, walletConnectProjectId } from "./config";

// Each public RPC rate limits, and some turn away VPNs, on its own; a failed read moves on to
// the next one rather than leaving the app unable to see the chain.
const rpc = fallback(chain.rpcUrls.default.http.map((url) => http(url)));

export const wagmiConfig = getDefaultConfig({
  appName: "PushPot",
  projectId: walletConnectProjectId || "pushpot-local",
  chains: [chain],
  transports: { [chain.id]: rpc },
});
