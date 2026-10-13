import type { ReactNode } from "react";

interface CheckInPanelProps {
  title: string;
  /** Which pot this is about, shown above the title. */
  context?: string;
  body: string;
  tone?: "default" | "error";
  children: ReactNode;
}

export function CheckInPanel({
  title,
  context,
  body,
  tone = "default",
  children,
}: CheckInPanelProps) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 pt-6">
        {context && <p className="text-lg text-mute">{context}</p>}
        <h1
          className={`font-display text-6xl leading-[0.9] font-black ${tone === "error" ? "text-flare" : ""}`}
        >
          {title}
        </h1>
        <p className="mt-4 text-lg">{body}</p>
      </div>
      <div className="mb-4 space-y-3">{children}</div>
    </div>
  );
}
