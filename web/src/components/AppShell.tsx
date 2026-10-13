import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Suspense } from "react";
import { Link, Outlet } from "react-router";
import { addressUrl, chain, getUsdcUrl, pushPotAddress } from "../lib/config";
import { ExternalLink } from "./ExternalLink";
import { OpenInMetaMask } from "./OpenInMetaMask";
import { PageSpinner } from "./PageSpinner";
import { Wordmark } from "./Wordmark";

export function AppShell() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-ink/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-md items-center justify-between gap-3 px-4">
          <Link to="/" aria-label="PushPot home" className="-ml-1 rounded-md px-1 py-2">
            <Wordmark />
          </Link>
          <div className="flex items-center gap-1">
            <Link
              to="/guide"
              className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-semibold text-mute hover:text-chalk"
            >
              How to
            </Link>
            <ConnectButton
              label="Connect"
              showBalance={false}
              chainStatus="icon"
              accountStatus={{ smallScreen: "avatar", largeScreen: "address" }}
            />
          </div>
        </div>
      </header>
      <OpenInMetaMask />

      <main className="mx-auto w-full max-w-md flex-1 px-4">
        <Suspense fallback={<PageSpinner />}>
          <Outlet />
        </Suspense>
      </main>

      <footer className="mx-auto flex w-full max-w-md flex-wrap items-center gap-x-6 px-4 pt-8 pb-6 text-sm text-mute">
        <ExternalLink href={getUsdcUrl} className="inline-flex min-h-11 items-center text-chalk">
          Get USDC on Arc
        </ExternalLink>
        <ExternalLink
          href={addressUrl(pushPotAddress)}
          className="inline-flex min-h-11 items-center"
        >
          Contract
        </ExternalLink>
        <span>Running on {chain.name}</span>
      </footer>
    </div>
  );
}
