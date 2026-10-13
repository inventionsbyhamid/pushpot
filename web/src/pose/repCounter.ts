import { Ema, SmoothedSignal, type OneEuroOptions } from "./filters";
import { angleAt, clamp, distance, isInFrame, median, offsetFromLine, toPixels, type Point } from "./geometry";
import {
  jointIndex,
  otherSide,
  POSE_LANDMARK_COUNT,
  visibilityOf,
  type Joint,
  type Landmark,
  type Side,
} from "./landmarks";
import { checkFraming, FRAME_MARGIN, type SetupChecks } from "./setup";
import type { RepSummary } from "./types";

export type Phase = "setup" | "up" | "down" | "lost";

export type Cue =
  | "go_lower"
  | "lock_out"
  | "hips_sag"
  | "hips_pike"
  | "move_into_frame"
  | "turn_sideways"
  | "get_in_plank";

export interface PoseFrame {
  /** Milliseconds on a monotonic clock. */
  t: number;
  /** All 33 pose landmarks, or an empty array when no pose was detected. */
  landmarks: readonly Landmark[];
  width: number;
  height: number;
}

export interface CounterUpdate {
  count: number;
  phase: Phase;
  cue: Cue | null;
  /** Smoothed elbow angle used for counting; held through invalid frames. */
  elbow: number | null;
  /** Smoothed shoulder–hip–ankle angle; held through invalid frames. */
  body: number | null;
  valid: boolean;
  side: Side;
  /** Mean visibility (0–1) of the landmarks used this frame. */
  vis: number;
  checks: SetupChecks;
}

export interface RepCounter {
  push(frame: PoseFrame): CounterUpdate;
  readonly reps: readonly RepSummary[];
}

export interface CounterConfig {
  /** Elbow angle (°) at or below which the bottom of a rep is reached. */
  downAngle: number;
  /** Initial lockout angle (°); adapts to the user's top position once reps come in. */
  upAngle: number;
  /** Bounds for the adaptive lockout angle. */
  upAngleRange: readonly [number, number];
  /** Elbow and body angle (°) that define the starting plank. */
  plankAngle: number;
  /** Lowest shoulder–hip–ankle angle (°) allowed during a rep. */
  minBodyAngle: number;
  /** Shortest top → bottom → top cycle (ms) that counts. */
  minCycleMs: number;
  /** Longest rep (ms) before it is abandoned. */
  maxRepMs: number;
}

export const DEFAULT_CONFIG: CounterConfig = {
  downAngle: 100,
  upAngle: 150,
  // The server recounts with a 145° lockout, so the client never accepts less.
  upAngleRange: [145, 155],
  plankAngle: 150,
  minBodyAngle: 145,
  minCycleMs: 500,
  maxRepMs: 8000,
};

const ANGLE_FILTER: OneEuroOptions = { minCutoff: 1, beta: 0.02, dCutoff: 1 };
const MIN_VISIBILITY = 0.5;
const SIDE_EMA_ALPHA = 0.3;
const SIDE_SWITCH_MARGIN = 0.1;
const SIDE_SWITCH_FRAMES = 8;
const CONFIRM_FRAMES = 2;
const LOST_AFTER_MS = 1000;
const SETUP_HOLD_MS = 500;
const MIN_REP_GAP_MS = 500;
const MIN_REP_FRAMES = 5;
const MIN_VALID_RATIO = 0.7;
const MAX_WRIST_DRIFT = 0.25;
const TOP_MARGIN = 12;
const TOP_HISTORY = 5;
const ADAPT_AFTER_REPS = 3;
const SHALLOW_ANGLE = 135;
const REBOUND_ANGLE = 130;
const REDROP_ANGLE = 110;
const STALE_DESCENT_MS = 4000;
const CUE_HOLD_MS = 2000;

const SIDE_JOINTS: readonly Joint[] = ["shoulder", "elbow", "wrist", "hip", "ankle"];

interface Measurement {
  valid: boolean;
  elbow: number;
  body: number;
  torso: number;
  wrist: Point;
  hipOffset: number;
  vis: number;
  framing: Omit<SetupChecks, "plank">;
}

interface Cycle {
  start: number;
  /** Highest elbow angle at the top before this cycle began. */
  top: number;
  reachedDown: boolean;
  rebounded: boolean;
  fault: Cue | null;
  minElbow: number;
  maxElbow: number;
  bottomAt: number;
  minBody: number;
  frames: number;
  validFrames: number;
  visSum: number;
  torsoSum: number;
  wristAnchor: Point;
  wristDrift: number;
}

function measure(pose: readonly Landmark[], side: Side, width: number, height: number): Measurement {
  const at = (joint: Joint): Landmark => pose[jointIndex(side, joint)] ?? { x: 0, y: 0, z: 0, visibility: 0 };
  const usable = (l: Landmark) => visibilityOf(l) >= MIN_VISIBILITY && isInFrame(l, FRAME_MARGIN);
  const px = (l: Landmark) => toPixels(l, width, height);

  const shoulder = at("shoulder");
  const elbow = at("elbow");
  const wrist = at("wrist");
  const hip = at("hip");
  const ankle = at("ankle");
  const foot = usable(ankle) ? ankle : at("knee");
  const used = [shoulder, elbow, wrist, hip, foot];

  return {
    valid: [shoulder, hip, elbow, wrist].every(usable),
    elbow: angleAt(px(shoulder), px(elbow), px(wrist)),
    body: angleAt(px(shoulder), px(hip), px(foot)),
    torso: distance(px(shoulder), px(hip)),
    wrist: px(wrist),
    hipOffset: offsetFromLine(px(hip), px(shoulder), px(foot)),
    vis: used.reduce((sum, l) => sum + visibilityOf(l), 0) / used.length,
    framing: checkFraming(pose, side, width, height),
  };
}

function sideVisibility(pose: readonly Landmark[], side: Side): number {
  return SIDE_JOINTS.reduce((sum, joint) => sum + visibilityOf(pose[jointIndex(side, joint)]), 0) / SIDE_JOINTS.length;
}

/**
 * Counts pushups from a stream of side-view pose frames. Pure: no DOM, no clock of its own.
 *
 * Phases: `setup` until a side-on plank is held, then `up` ⇄ `down` with hysteresis on the
 * smoothed elbow angle. A rep is counted on the way back up only if it passes every form and
 * timing check; otherwise a cue explains why. Frames with unreliable landmarks never change
 * state, and a long run of them reports `lost`.
 */
export function createRepCounter(config: Partial<CounterConfig> = {}): RepCounter {
  const cfg: CounterConfig = { ...DEFAULT_CONFIG, ...config };
  const elbowSignal = new SmoothedSignal(ANGLE_FILTER);
  const bodySignal = new SmoothedSignal(ANGLE_FILTER);
  const sideScore: Record<Side, Ema> = { left: new Ema(SIDE_EMA_ALPHA), right: new Ema(SIDE_EMA_ALPHA) };
  const reps: RepSummary[] = [];
  const tops: number[] = [];

  let side: Side | null = null;
  let switchStreak = 0;
  let phase: Exclude<Phase, "lost"> = "setup";
  let lost = false;
  let lastValidAt: number | null = null;
  let elbow: number | null = null;
  let body: number | null = null;
  let setupSince: number | null = null;
  let downStreak = 0;
  let upStreak = 0;
  let upAngle = cfg.upAngle;
  let top = 0;
  let cycle: Cycle | null = null;
  let lastRepEnd: number | null = null;
  let event: { cue: Cue; at: number } | null = null;

  function resetSignals(): void {
    elbowSignal.reset();
    bodySignal.reset();
    downStreak = 0;
    upStreak = 0;
  }

  function selectSide(pose: readonly Landmark[]): Side {
    const left = sideScore.left.push(sideVisibility(pose, "left"));
    const right = sideScore.right.push(sideVisibility(pose, "right"));
    if (side === null) return left >= right ? "left" : "right";

    const current = side === "left" ? left : right;
    const other = side === "left" ? right : left;
    switchStreak = other >= current + SIDE_SWITCH_MARGIN ? switchStreak + 1 : 0;
    if (switchStreak < SIDE_SWITCH_FRAMES) return side;

    switchStreak = 0;
    resetSignals();
    return otherSide(side);
  }

  function startCycle(t: number, m: Measurement): Cycle {
    return {
      start: t,
      top,
      reachedDown: false,
      rebounded: false,
      fault: null,
      minElbow: Infinity,
      maxElbow: -Infinity,
      bottomAt: t,
      minBody: Infinity,
      frames: 0,
      validFrames: 0,
      visSum: 0,
      torsoSum: 0,
      wristAnchor: m.wrist,
      wristDrift: 0,
    };
  }

  function track(c: Cycle, t: number, m: Measurement, e: number, b: number): void {
    c.frames += 1;
    c.validFrames += 1;
    c.visSum += m.vis;
    c.torsoSum += m.torso;
    c.wristDrift = Math.max(c.wristDrift, distance(m.wrist, c.wristAnchor));
    if (e < c.minElbow) {
      c.minElbow = e;
      c.bottomAt = t;
    }
    c.maxElbow = Math.max(c.maxElbow, e);
    c.minBody = Math.min(c.minBody, b);
    if (b < cfg.minBodyAngle && c.fault === null) {
      c.fault = m.hipOffset > 0 ? "hips_sag" : "hips_pike";
      event = { cue: c.fault, at: t };
    }
  }

  function finishRep(c: Cycle, t: number): void {
    const duration = t - c.start;
    const counts =
      c.fault === null &&
      duration >= cfg.minCycleMs &&
      duration <= cfg.maxRepMs &&
      (lastRepEnd === null || t - lastRepEnd >= MIN_REP_GAP_MS) &&
      c.validFrames >= MIN_REP_FRAMES &&
      c.validFrames / c.frames >= MIN_VALID_RATIO &&
      c.wristDrift <= MAX_WRIST_DRIFT * (c.torsoSum / c.validFrames);
    if (!counts) return;

    reps.push({
      start: c.start,
      bottom: c.bottomAt,
      end: t,
      min_elbow: c.minElbow,
      max_elbow: c.maxElbow,
      min_body: c.minBody,
      vis: c.visSum / c.frames,
    });
    lastRepEnd = t;
    event = null;

    tops.push(c.top);
    if (tops.length > TOP_HISTORY) tops.shift();
    if (reps.length >= ADAPT_AFTER_REPS) {
      upAngle = clamp(median(tops) - TOP_MARGIN, cfg.upAngleRange[0], cfg.upAngleRange[1]);
    }
  }

  function step(t: number, m: Measurement, e: number, b: number): void {
    downStreak = e <= cfg.downAngle ? downStreak + 1 : 0;
    upStreak = e >= upAngle ? upStreak + 1 : 0;

    if (phase === "setup") {
      const ready = m.framing.inFrame && m.framing.sideOn && e >= cfg.plankAngle && b >= cfg.plankAngle;
      setupSince = ready ? (setupSince ?? t) : null;
      if (setupSince !== null && t - setupSince >= SETUP_HOLD_MS) {
        phase = "up";
        top = e;
        cycle = null;
      }
      return;
    }

    if (phase === "up") {
      if (cycle && !cycle.reachedDown && t - cycle.start > STALE_DESCENT_MS) cycle = null;
      if (!cycle) {
        if (e >= upAngle) {
          top = Math.max(top, e);
          return;
        }
        cycle = startCycle(t, m);
      }
      track(cycle, t, m, e, b);

      if (downStreak >= CONFIRM_FRAMES) {
        phase = "down";
        cycle.reachedDown = true;
      } else if (upStreak >= CONFIRM_FRAMES) {
        if (cycle.minElbow <= SHALLOW_ANGLE) {
          event = { cue: "go_lower", at: t };
        }
        cycle = null;
        top = e;
      }
      return;
    }

    if (!cycle) {
      phase = "up";
      return;
    }
    track(cycle, t, m, e, b);

    if (t - cycle.start > cfg.maxRepMs) {
      phase = "setup";
      setupSince = null;
      cycle = null;
      return;
    }
    if (upStreak >= CONFIRM_FRAMES) {
      finishRep(cycle, t);
      if (cycle.fault) event = { cue: cycle.fault, at: t };
      phase = "up";
      cycle = null;
      top = e;
      return;
    }
    if (e > REBOUND_ANGLE) {
      cycle.rebounded = true;
    } else if (cycle.rebounded && e < REDROP_ANGLE) {
      cycle.rebounded = false;
      cycle.fault ??= "lock_out";
      event = { cue: "lock_out", at: t };
    }
  }

  function setupCue(checks: SetupChecks): Cue | null {
    if (!checks.inFrame) return "move_into_frame";
    if (!checks.sideOn) return "turn_sideways";
    if (!checks.plank) return "get_in_plank";
    return null;
  }

  function push(frame: PoseFrame): CounterUpdate {
    const { t, landmarks, width, height } = frame;
    lastValidAt ??= t;

    const pose = landmarks.length >= POSE_LANDMARK_COUNT ? landmarks : null;
    if (pose) side = selectSide(pose);
    const m = pose && side ? measure(pose, side, width, height) : null;
    const valid = m?.valid ?? false;

    if (m && valid) {
      if (lost) {
        lost = false;
        resetSignals();
      }
      lastValidAt = t;
      elbow = elbowSignal.push(m.elbow, t);
      body = bodySignal.push(m.body, t);
      step(t, m, elbow, body);
    } else {
      if (cycle) {
        cycle.frames += 1;
        cycle.visSum += m?.vis ?? 0;
      }
      if (t - lastValidAt > LOST_AFTER_MS) {
        lost = true;
        setupSince = null;
      }
    }

    const checks: SetupChecks = {
      inFrame: valid && (m?.framing.inFrame ?? false),
      sideOn: m?.framing.sideOn ?? false,
      plank: valid && elbow !== null && body !== null && elbow >= cfg.plankAngle && body >= cfg.plankAngle,
    };
    const stateCue = lost ? "move_into_frame" : phase === "setup" ? setupCue(checks) : null;
    const eventCue = event && t - event.at < CUE_HOLD_MS ? event.cue : null;

    return {
      count: reps.length,
      phase: lost ? "lost" : phase,
      cue: stateCue ?? eventCue,
      elbow,
      body,
      valid,
      side: side ?? "left",
      vis: m?.vis ?? 0,
      checks,
    };
  }

  return {
    push,
    get reps() {
      return reps;
    },
  };
}
