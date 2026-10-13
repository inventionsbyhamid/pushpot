import { useRef, useState } from "react";
import { ScoreDigits } from "../../components/ScoreDigits";
import { useMediaQuery } from "../workout/useMediaQuery";
import { Athlete, type AngleReadout, type Tone } from "./Athlete";
import {
  buildTimeline,
  CUE_TEXT,
  demoSteps,
  frameAt,
  MIN_BODY_ANGLE,
  TARGET,
  type DemoCue,
  type DemoFrame,
} from "./demoTimeline";
import { CheckIcon, ChevronIcon, PauseIcon, PlayIcon } from "./icons";
import { solvePose } from "./kinematics";
import { useLoopTime } from "./useLoopTime";

const TIMELINE = buildTimeline();
const STEPS = demoSteps(TIMELINE);

// The scene shares the screen's 16:10 shape, so HUD percentages and scene units line up.
const SCENE_WIDTH = 200;
const SCENE_HEIGHT = 125;
const FLOOR_Y = 98;
const HORIZON_Y = 86;
const WALL_Y = 92;
const ANKLE_X = 22;

const DESCRIPTION =
  "Animated demo of the camera counting pushups. Clean reps count. A half rep gets the cue Go lower " +
  "and a rep with sagging hips gets Keep your body straight, and neither counts. The set ends at " +
  `${TARGET} of ${TARGET}, recorded on Arc.`;

/**
 * A looping, scripted pushup set on a phone's camera screen, showing what the counter looks
 * for. With reduced motion it becomes a set of still frames to step through.
 */
export function PushupDemo({ className = "" }: { className?: string }) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const screenRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [step, setStep] = useState(0);
  const loopTime = useLoopTime(screenRef, TIMELINE.duration, !reducedMotion && !paused);
  const current = STEPS[step]!;
  const frame = frameAt(TIMELINE, reducedMotion ? current.time : loopTime);

  return (
    <figure className={className}>
      <div className="relative rounded-[1.75rem] border border-line bg-raised p-[7px] shadow-[0_28px_50px_-28px_rgb(0_0_0/0.9)]">
        <div
          ref={screenRef}
          role="img"
          aria-label={reducedMotion ? current.caption : DESCRIPTION}
          className="@container relative aspect-[16/10] overflow-hidden rounded-[1.3rem] bg-linear-to-b from-raised to-panel select-none"
        >
          <Scene frame={frame} />
          <span className="absolute top-1/2 left-[1.6cqw] size-[1.5cqw] -translate-y-1/2 rounded-full bg-ink ring-1 ring-line" />
          <Scoreboard count={frame.count} pulse={frame.pulse} noRep={frame.noRep} />
          <CueChip cue={frame.cue} />
          <Recorded opacity={frame.success} />
        </div>
      </div>

      {reducedMotion && (
        <div className="mt-3 flex items-center gap-3">
          <StepButton direction="left" disabled={step === 0} onClick={() => setStep(step - 1)} />
          <p aria-live="polite" className="min-h-11 flex-1 text-center text-sm">
            <span className="sr-only">
              Step {step + 1} of {STEPS.length}:{" "}
            </span>
            {current.caption}
          </p>
          <StepButton
            direction="right"
            disabled={step === STEPS.length - 1}
            onClick={() => setStep(step + 1)}
          />
        </div>
      )}

      <figcaption className="mt-3 flex items-center justify-between gap-4 text-sm text-mute">
        This is what the camera checks. Video never leaves your phone.
        {!reducedMotion && (
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            aria-label={paused ? "Play demo" : "Pause demo"}
            className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-raised text-chalk hover:border-mute"
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
        )}
      </figcaption>
    </figure>
  );
}

function Scene({ frame }: { frame: DemoFrame }) {
  const pose = solvePose({ elbow: frame.elbow, hipBend: frame.bend });
  const bodyLine = 180 - frame.bend;
  const accent: Tone = bodyLine >= MIN_BODY_ANGLE ? "volt" : "mute";
  const readouts: AngleReadout[] = [
    { joint: "elbow", value: frame.elbow, tone: frame.cue === "lower" ? "flare" : accent },
  ];
  // Only worth a label once the hips visibly leave the line.
  if (frame.bend > 12) {
    readouts.push({ joint: "hip", value: bodyLine, tone: accent === "volt" ? "volt" : "flare" });
  }

  return (
    <svg
      viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
      className="absolute inset-0 size-full"
      aria-hidden
    >
      <rect y={WALL_Y} width={SCENE_WIDTH} height={SCENE_HEIGHT - WALL_Y} className="fill-ink/50" />
      <line x2={SCENE_WIDTH} y1={WALL_Y} y2={WALL_Y} className="stroke-line" strokeWidth={0.6} />
      {/* Floorboards running away from a camera that sits on the floor. */}
      {[-260, -150, -60, 20, 100, 180, 260, 350, 460].map((x) => (
        <line
          key={x}
          x1={SCENE_WIDTH / 2 + (x - SCENE_WIDTH / 2) * ((WALL_Y - HORIZON_Y) / (SCENE_HEIGHT - HORIZON_Y))}
          y1={WALL_Y}
          x2={x}
          y2={SCENE_HEIGHT}
          className="stroke-line"
          strokeWidth={0.4}
        />
      ))}
      <ellipse cx={ANKLE_X + 74} cy={FLOOR_Y + 0.5} rx={80} ry={3} className="fill-black/40" />
      <g transform={`translate(${ANKLE_X} ${FLOOR_Y})`}>
        <Athlete pose={pose} arm={accent} body={accent} readouts={readouts} />
      </g>
    </svg>
  );
}

function Scoreboard({ count, pulse, noRep }: { count: number; pulse: number; noRep: boolean }) {
  return (
    <div className="absolute top-[3cqw] left-[4.5cqw] flex items-start gap-[1.5cqw]">
      <div
        className="dot-matrix rounded-[1.8cqw] border border-line bg-ink/80 px-[2.6cqw] pt-[1.3cqw] pb-[1.8cqw]"
        style={{
          borderColor: `color-mix(in oklab, var(--color-volt) ${Math.round(pulse * 100)}%, var(--color-line))`,
          boxShadow: `0 0 ${(4 * pulse).toFixed(2)}cqw color-mix(in oklab, var(--color-volt) ${Math.round(pulse * 45)}%, transparent)`,
        }}
      >
        <p className="font-mono text-[max(8px,2.2cqw)] leading-none tracking-[0.2em] text-mute uppercase">
          Reps
        </p>
        <p className="mt-[0.8cqw] flex items-baseline gap-[0.6cqw] font-display leading-[0.8] font-black">
          <span className="inline-block origin-bottom-left" style={{ transform: `scale(${1 + 0.14 * pulse})` }}>
            <ScoreDigits value={String(count)} className="text-[12cqw] text-volt glow-volt" />
          </span>
          <span className="text-[5cqw] text-mute tabular-nums">/{TARGET}</span>
        </p>
      </div>
      {noRep && (
        <span className="mt-[1cqw] animate-flip rounded-full border border-flare/60 bg-ink/85 px-[2cqw] py-[0.9cqw] font-display text-[max(10px,3cqw)] leading-none font-extrabold tracking-wide whitespace-nowrap text-flare uppercase">
          No rep
        </span>
      )}
    </div>
  );
}

function CueChip({ cue }: { cue: DemoCue | null }) {
  if (!cue) return null;
  const tone = cue === "good" ? "border-volt/60 text-volt" : "border-flare/60 text-flare";
  return (
    <div className="absolute inset-x-0 bottom-[2.6cqw] flex justify-center">
      <p
        key={cue}
        className={`animate-rise rounded-full border bg-ink/85 px-[3cqw] py-[1.3cqw] font-display text-[max(11px,3.6cqw)] leading-none font-extrabold tracking-wide whitespace-nowrap uppercase ${tone}`}
      >
        {CUE_TEXT[cue]}
      </p>
    </div>
  );
}

function Recorded({ opacity }: { opacity: number }) {
  if (opacity <= 0) return null;
  return (
    <div className="absolute inset-0 grid place-items-center bg-ink/85" style={{ opacity }}>
      <div className="text-center" style={{ transform: `scale(${0.9 + 0.1 * opacity})` }}>
        <ScoreDigits
          value={`${TARGET}/${TARGET}`}
          className="block font-display text-[20cqw] leading-[0.85] font-black text-volt glow-volt"
        />
        <p className="mt-[1.5cqw] inline-flex items-center gap-[1.2cqw] font-display text-[max(13px,4.6cqw)] leading-none font-extrabold uppercase">
          <CheckIcon className="size-[1.1em] text-volt" />
          Recorded on Arc
        </p>
      </div>
    </div>
  );
}

function StepButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={direction === "left" ? "Previous step" : "Next step"}
      className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-raised text-chalk hover:border-mute disabled:opacity-35"
    >
      <ChevronIcon direction={direction} />
    </button>
  );
}
