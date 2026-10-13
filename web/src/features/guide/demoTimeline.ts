// The landing demo's script: a few clean reps, one half rep, one with sagging hips, then the
// set is recorded. Everything on screen is a pure function of time into the loop.

export type RepKind = "clean" | "half" | "sag";
export type DemoCue = "good" | "lower" | "straight";

export const CUE_TEXT: Record<DemoCue, string> = {
  good: "Good rep",
  lower: "Go lower",
  straight: "Keep your body straight",
};

// The rep counter's thresholds (docs/DESIGN.md, "Rep counter").
export const DOWN_ANGLE = 100;
export const UP_ANGLE = 150;
export const MIN_BODY_ANGLE = 145;

export const TARGET = 10;
const SCRIPT: readonly RepKind[] = ["clean", "clean", "clean", "half", "sag", "clean", "clean"];

const TOP_ELBOW = 172;
const BOTTOM_ELBOW: Record<RepKind, number> = { clean: 82, half: 125, sag: 94 };
// Nobody holds a perfectly straight line.
const RESTING_BEND = 3;
const SAG_BEND = 50;

const INTRO_MS = 900;
const DESCENT_MS = 1100;
const BOTTOM_MS = 120;
const ASCENT_MS = 800;
const REST_MS = 450;
// Long enough to read the cue after a rep that didn't count.
const FAULT_REST_MS = 1300;
const GOOD_CUE_MS = 800;
const NO_REP_MS = 1400;
const PULSE_MS = 500;
const SUCCESS_MS = 2800;
const SUCCESS_FADE_MS = 350;

interface Move {
  start: number;
  end: number;
  elbow: readonly [number, number];
  bend: readonly [number, number];
}

interface Span {
  from: number;
  to: number;
}

interface Rep {
  kind: RepKind;
  start: number;
  /** When the elbow turns at the bottom. */
  bottom: number;
  /** When the elbow is back above the lockout angle. */
  end: number;
}

export interface DemoTimeline {
  duration: number;
  moves: Move[];
  reps: Rep[];
  counts: number[];
  cues: (Span & { cue: DemoCue })[];
  noReps: Span[];
  success: Span;
}

export interface DemoFrame {
  elbow: number;
  /** Hip bend away from a straight body line, degrees. */
  bend: number;
  count: number;
  cue: DemoCue | null;
  /** 1 the moment a rep counts, fading to 0. */
  pulse: number;
  noRep: boolean;
  /** Opacity of the "recorded" moment. */
  success: number;
}

// The same eased motion as the counter's synthetic test data.
const ease = (p: number) => (1 - Math.cos(Math.PI * p)) / 2;

/** Fraction of an eased move from `from` to `to` at which it passes `value`. */
function crossing(from: number, to: number, value: number): number {
  return Math.acos(1 - (2 * (value - from)) / (to - from)) / Math.PI;
}

export function buildTimeline(script: readonly RepKind[] = SCRIPT): DemoTimeline {
  const moves: Move[] = [];
  const reps: Rep[] = [];
  const counts: number[] = [];
  const cues: DemoTimeline["cues"] = [];
  const noReps: Span[] = [];
  let time = 0;
  let elbow = TOP_ELBOW;
  let bend = RESTING_BEND;

  const move = (ms: number, toElbow = elbow, toBend = bend) => {
    moves.push({ start: time, end: time + ms, elbow: [elbow, toElbow], bend: [bend, toBend] });
    time += ms;
    elbow = toElbow;
    bend = toBend;
  };

  move(INTRO_MS);
  for (const kind of script) {
    const start = time;
    const low = BOTTOM_ELBOW[kind];
    move(DESCENT_MS, low, kind === "sag" ? SAG_BEND : bend);
    move(BOTTOM_MS);
    const bottom = time;
    move(ASCENT_MS, TOP_ELBOW);
    const end = bottom + crossing(low, TOP_ELBOW, UP_ANGLE) * ASCENT_MS;
    reps.push({ kind, start, bottom, end });

    if (kind === "clean") {
      counts.push(end);
      cues.push({ from: end, to: end + GOOD_CUE_MS, cue: "good" });
      move(REST_MS);
      continue;
    }
    const faultAt =
      kind === "half"
        ? bottom
        : start + crossing(RESTING_BEND, SAG_BEND, 180 - MIN_BODY_ANGLE) * DESCENT_MS;
    cues.push({ from: faultAt, to: time + FAULT_REST_MS, cue: kind === "half" ? "lower" : "straight" });
    noReps.push({ from: end, to: end + NO_REP_MS });
    move(FAULT_REST_MS, TOP_ELBOW, RESTING_BEND);
  }

  const success: Span = { from: time, to: time + SUCCESS_MS };
  move(SUCCESS_MS);
  return { duration: time, moves, reps, counts, cues, noReps, success };
}

const within = (span: Span, t: number) => t >= span.from && t < span.to;

export function frameAt(timeline: DemoTimeline, t: number): DemoFrame {
  const { moves, counts, cues, noReps, success } = timeline;
  const current = moves.find((m) => t < m.end) ?? moves[moves.length - 1]!;
  const p = ease(Math.min(1, Math.max(0, (t - current.start) / (current.end - current.start))));
  const lerp = ([from, to]: readonly [number, number]) => from + (to - from) * p;

  const counted = counts.filter((at) => at <= t);
  const lastCount = counted[counted.length - 1];
  const fadeIn = (t - success.from) / SUCCESS_FADE_MS;
  const fadeOut = (success.to - t) / SUCCESS_FADE_MS;
  const showing = within(success, t) ? Math.min(1, fadeIn, fadeOut) : 0;
  // The count resets behind the overlay so the loop starts over cleanly.
  const reset = t >= success.to - SUCCESS_FADE_MS;

  return {
    elbow: lerp(current.elbow),
    bend: lerp(current.bend),
    count: TARGET - counts.length + (reset ? 0 : counted.length),
    cue: cues.find((span) => within(span, t))?.cue ?? null,
    pulse: lastCount === undefined ? 0 : Math.max(0, 1 - (t - lastCount) / PULSE_MS),
    noRep: noReps.some((span) => within(span, t)),
    success: showing,
  };
}

export interface DemoStep {
  time: number;
  caption: string;
}

/** Still frames that tell the same story, for people who prefer reduced motion. */
export function demoSteps(timeline: DemoTimeline): DemoStep[] {
  const first = (kind: RepKind) => timeline.reps.find((rep) => rep.kind === kind)!;
  const clean = first("clean");
  return [
    { time: 0, caption: "Start in a plank, arms straight. The camera tracks your arm and body line." },
    { time: clean.bottom, caption: `Lower until your elbow passes ${DOWN_ANGLE}°.` },
    { time: clean.end + 150, caption: `Press back above ${UP_ANGLE}°. Rep counted.` },
    { time: first("half").bottom + 100, caption: "Stop short and it's a half rep. No count." },
    { time: first("sag").bottom, caption: "Hips sag and the body line breaks. No count." },
    { time: timeline.success.from + 1000, caption: "Hit your target and the set is recorded on Arc." },
  ];
}
