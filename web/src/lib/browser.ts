const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;

/** Social apps' embedded browsers block camera access and can't reach wallet apps. */
export const isInAppBrowser = /Instagram|FBAN|FBAV|Line\/|WhatsApp|Telegram|Twitter/i.test(
  userAgent,
);

export const isMobile = /Android|iPhone|iPad|iPod/i.test(userAgent);

export const isAndroid = /Android/i.test(userAgent);

export function hasInjectedWallet(): boolean {
  return typeof window !== "undefined" && "ethereum" in window && !!window.ethereum;
}

export function metaMaskDappUrl(): string {
  return `https://link.metamask.io/dapp/${window.location.host}${window.location.pathname}`;
}

/** Android can hand a URL straight to Chrome; iOS offers no equivalent. */
export function chromeIntentUrl(): string {
  const { host, pathname, search } = window.location;
  return `intent://${host}${pathname}${search}#Intent;scheme=https;package=com.android.chrome;end`;
}
