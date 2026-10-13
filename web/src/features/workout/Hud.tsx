import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Button } from "../../components/Button";
import { ScoreDigits } from "../../components/ScoreDigits";
import { Spinner } from "../../components/Spinner";
import type { PerfStats } from "./perfStats";
import type { PoseBackend } from "./usePoseLoop";

export function Scoreboard({ count, target }: { count: number; target?: number }) {
  return (
    <div className="dot-matrix rounded-xl border border-line/80 bg-ink/85 px-4 pt-2 pb-3">
      <p className="font-mono text-[0.6875rem] tracking-[0.2em] text-mute uppercase">Reps</p>
      <p className="flex items-baseline gap-1.5 font-display leading-[0.8] font-black">
        <ScoreDigits value={String(count)} className="text-[clamp(4.5rem,22vmin,9rem)] text-volt glow-volt" />
        {target !== undefined && (
          <span className="text-[clamp(1.5rem,7vmin,3rem)] text-mute tabular-nums">/{target}</span>
        )}
      </p>
    </div>
  );
}

export type Tone = "fault" | "pending";

export function StatusBanner({ tone, busy = false, children }: { tone: Tone; busy?: boolean; children: ReactNode }) {
  const color = tone === "fault" ? "border-flare/60 text-flare" : "border-amber/50 text-amber";
  return (
    <p
      className={`inline-flex items-center gap-3 rounded-full border bg-ink/85 px-5 py-2.5 font-display text-2xl leading-none font-extrabold tracking-wide uppercase ${color}`}
    >
      {busy && <Spinner className="size-5" />}
      {children}
    </p>
  );
}

export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-12 place-items-center rounded-full border border-line bg-ink/85 text-chalk active:bg-raised"
    >
      {children}
    </button>
  );
}

interface ErrorPanelProps {
  title: string;
  message: string;
  onRetry: () => void;
  onExit?: () => void;
}

export function ErrorPanel({ title, message, onRetry, onExit }: ErrorPanelProps) {
  return (
    <div role="alert" className="absolute inset-0 grid place-items-center overflow-y-auto bg-ink px-4 py-8">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-5">
        <p className="font-display text-3xl leading-none font-black text-flare uppercase">{title}</p>
        <p className="mt-3 text-mute">{message}</p>
        <div className="mt-6 flex gap-3">
          <Button onClick={onRetry} className="flex-1">
            Retry
          </Button>
          {onExit && (
            <Button variant="secondary" onClick={onExit}>
              Exit
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DoneOverlay({ count }: { count: number }) {
  return (
    <div role="status" className="absolute inset-0 grid place-items-center bg-ink/85 px-4 text-center">
      <div>
        <p className="font-mono text-xs tracking-[0.2em] text-volt uppercase">Done</p>
        <ScoreDigits
          value={String(count)}
          className="block font-display text-[clamp(7rem,38vmin,14rem)] leading-none font-black text-volt glow-volt"
        />
        <p className="font-display text-3xl font-extrabold uppercase">{count === 1 ? "pushup" : "pushups"}</p>
      </div>
    </div>
  );
}

interface PerfHudProps {
  stats: PerfStats;
  backend: PoseBackend | null;
  videoRef: RefObject<HTMLVideoElement | null>;
}

/** Pose loop diagnostics, shown with `?debug` in the URL. */
export function PerfHud({ stats, backend, videoRef }: PerfHudProps) {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const update = () => {
      const video = videoRef.current;
      const p50 = stats.inferenceP50();
      setLines([
        `${stats.fps(performance.now())} fps`,
        `infer ${p50 === null ? "n/a" : `${p50.toFixed(1)} ms`}`,
        backend ? `${backend.delegate} · ${backend.mode}` : "loading",
        video?.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : "no video",
      ]);
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [stats, backend, videoRef]);

  return (
    <div className="pointer-events-none absolute top-1/2 left-[max(0.5rem,env(safe-area-inset-left))] -translate-y-1/2 rounded-md bg-ink/80 px-2 py-1.5 font-mono text-[0.6875rem] leading-snug text-volt tabular-nums">
      {lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}
