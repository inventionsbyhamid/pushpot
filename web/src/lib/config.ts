import { getAddress, type Address } from "viem";
import { arc, arcTestnet } from "viem/chains";

const chainId = Number(import.meta.env.VITE_CHAIN_ID ?? arcTestnet.id);
if (chainId !== arc.id && chainId !== arcTestnet.id) {
  throw new Error(`Unsupported VITE_CHAIN_ID ${chainId}`);
}

export const chain = chainId === arc.id ? arc : arcTestnet;
export const pushPotAddress: Address = getAddress(
  import.meta.env.VITE_PUSHPOT_ADDRESS ?? "0x0000000000000000000000000000000000000000",
);
export const usdcAddress: Address = "0x3600000000000000000000000000000000000000";
/** The only oracle the app trusts to judge pots; it refuses to stake into pots judged by any other. */
export const trustedOracle: Address = getAddress(
  import.meta.env.VITE_ORACLE_ADDRESS ?? "0x0000000000000000000000000000000000000000",
);
export const usdcDecimals = 6;
export const explorerUrl = chain.blockExplorers.default.url;
export const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "";
export const getUsdcUrl = "https://portal.arc.io/deposit";

export const txUrl = (hash: string) => `${explorerUrl}/tx/${hash}`;
export const addressUrl = (address: string) => `${explorerUrl}/address/${address}`;
