import { useAccount } from "wagmi";
import { hasInjectedWallet, isMobile, metaMaskDappUrl } from "../lib/browser";

/** Mobile browsers can't talk to wallet apps directly; MetaMask's own browser can. */
export function OpenInMetaMask() {
  const { isConnected } = useAccount();
  if (!isMobile || isConnected || hasInjectedWallet()) return null;

  return (
    <a
      href={metaMaskDappUrl()}
      className="flex min-h-11 items-center justify-center gap-2 border-b border-line bg-panel px-4 text-sm text-mute"
    >
      Have MetaMask?{" "}
      <span className="font-semibold text-chalk underline underline-offset-4">
        Open PushPot in the MetaMask app
      </span>
    </a>
  );
}
