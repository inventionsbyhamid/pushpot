import { useState } from "react";
import { chromeIntentUrl, isAndroid, isInAppBrowser } from "../lib/browser";

export function InAppBrowserBanner() {
  const [copied, setCopied] = useState(false);
  if (!isInAppBrowser) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div role="note" className="bg-amber px-4 py-3 text-ink">
      <div className="mx-auto flex max-w-md items-center gap-3">
        <p className="flex-1 text-sm leading-snug font-semibold">
          Open this page in {isAndroid ? "Chrome" : "Safari"} to use your camera and wallet.
        </p>
        {isAndroid ? (
          <a
            href={chromeIntentUrl()}
            className="grid min-h-11 place-items-center rounded-lg bg-ink px-3 text-sm font-bold text-amber"
          >
            Open
          </a>
        ) : (
          <button
            type="button"
            onClick={copy}
            className="min-h-11 rounded-lg bg-ink px-3 text-sm font-bold text-amber"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        )}
      </div>
    </div>
  );
}
