// Synthetic side-view pushup landmarks for tests.
import type { Point } from "./geometry";
import { jointIndex, otherSide, POSE_LANDMARK_COUNT, type Joint, type Landmark, type Side } from "./landmarks";
import type { PoseFrame } from "./repCounter";

/** Angle in degrees as a function of time in milliseconds. */
export type Curve = (t: number) => number;

export interface Segment {
  ms: number;
  at: (t: number) => number;
}

export function hold(angle: number, ms: number): Segment {
  return { ms, at: () => angle };
}

/** Eased move from one angle to another. */
export function ramp(from: number, to: number, ms: number): Segment {
  return { ms, at: (t) => from + ((to - from) * (1 - Math.cos((Math.PI * t) / ms))) / 2 };
}

/** `count` reps starting and ending at `high`, each a cosine dip to `low`, optionally pausing at the top. */
export function reps(count: number, periodMs: number, low: number, high: number, pauseMs = 0): Segment {
  const mid = (low + high) / 2;
  const amplitude = (high - low) / 2;
  const span = periodMs + pauseMs;
  return {
    ms: count * span,
    at: (t) => {
      const inRep = t % span;
      return inRep < periodMs ? mid + amplitude * Math.cos((2 * Math.PI * inRep) / periodMs) : high;
    },
  };
}

export function sequence(...segments: Segment[]): { curve: Curve; durationMs: number } {
  const durationMs = segments.reduce((sum, s) => sum + s.ms, 0);
  const curve: Curve = (t) => {
    let offset = 0;
    for (const segment of segments) {
      if (t < offset + segment.ms) return segment.at(t - offset);
      offset += segment.ms;
    }
    const last = segments[segments.length - 1];
    return last ? last.at(last.ms) : 180;
  };
  return { curve, durationMs };
}

export interface SyntheticOptions {
  durationMs: number;
  elbow: Curve;
  /** Shoulder–hip–ankle angle; below 180 the hips sag towards the floor. */
  body?: Curve;
  /** Near-side visibility. */
  visibility?: Curve;
  /** While true, landmarks are scattered with low visibility, as when the user is occluded. */
  dropout?: (t: number) => boolean;
  fps?: number;
  width?: number;
  height?: number;
  /** Uniform noise (±degrees) on the elbow angle. */
  elbowJitter?: number;
  /** Uniform noise (±pixels) on every landmark. */
  jitterPx?: number;
  seed?: number;
  side?: Side;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAD = Math.PI / 180;

/** Pixel positions of a plank facing left, wrists on the floor below the shoulders. */
function plankJoints(elbowDeg: number, bodyDeg: number, width: number, height: number): Record<Joint, Point> {
  const ground = 0.84 * height;
  const arm = 0.12 * width;
  const wrist = { x: 0.3 * width, y: ground };
  const reach = arm * Math.sqrt(2 - 2 * Math.cos(elbowDeg * RAD));
  const shoulder = { x: wrist.x, y: wrist.y - reach };
  const tilt = Math.acos(reach / (2 * arm));
  const elbow = { x: shoulder.x + arm * Math.sin(tilt), y: shoulder.y + arm * Math.cos(tilt) };

  const ankle = { x: 0.88 * width, y: ground - 0.03 * height };
  const dx = ankle.x - shoulder.x;
  const dy = ankle.y - shoulder.y;
  const length = Math.hypot(dx, dy);
  const sag = length / 2 / Math.tan((bodyDeg * RAD) / 2);
  const hip = {
    x: (shoulder.x + ankle.x) / 2 - (dy / length) * sag,
    y: (shoulder.y + ankle.y) / 2 + (dx / length) * sag,
  };
  const knee = { x: (hip.x + ankle.x) / 2, y: (hip.y + ankle.y) / 2 };
  const foot = { x: ankle.x + 0.02 * width, y: ankle.y + 0.02 * height };
  return { shoulder, elbow, wrist, hip, knee, ankle, foot };
}

export function synthesize(options: SyntheticOptions): PoseFrame[] {
  const {
    durationMs,
    elbow,
    body = () => 178,
    visibility = () => 0.95,
    dropout = () => false,
    fps = 30,
    width = 640,
    height = 480,
    elbowJitter = 0,
    jitterPx = 0,
    seed = 1,
    side = "left",
  } = options;
  const random = mulberry32(seed);
  const noise = (amount: number) => (random() * 2 - 1) * amount;
  const frames: PoseFrame[] = [];

  for (let i = 0; i * (1000 / fps) <= durationMs; i++) {
    const t = i * (1000 / fps);

    if (dropout(t)) {
      const landmarks = Array.from({ length: POSE_LANDMARK_COUNT }, () => ({
        x: random(),
        y: random(),
        z: 0,
        visibility: 0.2,
      }));
      frames.push({ t, landmarks, width, height });
      continue;
    }

    const joints = plankJoints(elbow(t) + noise(elbowJitter), body(t), width, height);
    const near = visibility(t);
    const far = Math.max(0.05, near - 0.5);
    const head = { x: joints.shoulder.x - 0.07 * width, y: joints.shoulder.y - 0.03 * height };
    const landmarks: Landmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, (_, index) => ({
      x: (index < 11 ? head.x : joints.wrist.x) / width,
      y: (index < 11 ? head.y : joints.wrist.y) / height,
      z: 0,
      visibility: near,
    }));
    for (const [joint, point] of Object.entries(joints) as [Joint, Point][]) {
      landmarks[jointIndex(side, joint)] = {
        x: (point.x + noise(jitterPx)) / width,
        y: (point.y + noise(jitterPx)) / height,
        z: 0,
        visibility: near,
      };
      landmarks[jointIndex(otherSide(side), joint)] = {
        x: (point.x - 0.01 * width + noise(jitterPx)) / width,
        y: (point.y - 0.012 * height + noise(jitterPx)) / height,
        z: 0,
        visibility: far,
      };
    }
    frames.push({ t, landmarks, width, height });
  }
  return frames;
}
