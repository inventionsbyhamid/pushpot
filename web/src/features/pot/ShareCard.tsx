import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { formatUsdc } from "../../lib/format";
import { cadenceLabel } from "../../lib/pot";
import type { Pot } from "../../lib/types";

export function ShareCard({ pot, inviting }: { pot: Pot; inviting: boolean }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/p/${pot.id}`;
  const text = `${cadenceLabel(pot)}, ${formatUsdc(pot.stake)} stake. Join "${pot.title}" on PushPot.`;
  const canShare = typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: pot.title, text, url });
    } catch {
      // Dismissing the share sheet rejects; nothing to report.
    }
  };

  return (
    <section aria-labelledby="share" className="mt-10">
      <h2 id="share" className="mb-1 font-display text-4xl font-extrabold">
        {inviting ? "Invite friends" : "Share"}
      </h2>
      <p className="mb-4 text-mute">
        {inviting
          ? "Anyone with the link can join until the pot starts."
          : "Let people follow along."}
      </p>
      <div className="flex gap-4 rounded-2xl border border-line bg-panel p-4">
        <div className="shrink-0 rounded-lg bg-chalk p-2 text-ink">
          <QRCodeSVG
            value={url}
            size={112}
            bgColor="transparent"
            fgColor="currentColor"
            marginSize={0}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
          <p className="truncate font-mono text-sm text-mute">{url.replace(/^https?:\/\//, "")}</p>
          <Button variant="secondary" className="min-h-11 w-full text-lg" onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </Button>
          {canShare && (
            <Button variant="secondary" className="min-h-11 w-full text-lg" onClick={share}>
              Share
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
