import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { chain, walletConnectProjectId } from "./config";

export const wagmiConfig = getDefaultConfig({
  appName: "PushPot",
  projectId: walletConnectProjectId || "pushpot-local",
  chains: [chain],
  transports: { [chain.id]: http() },
});
