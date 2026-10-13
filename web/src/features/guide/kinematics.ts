// Side-view pushup figure. Units are centimetres for an adult of about 1.75 m, with x running
// from the feet towards the head and y up from the floor.
import { distance, type Point as Vec } from "../../pose/geometry";

export type { Vec };

export interface Skeleton {
  toe: Vec;
  ankle: Vec;
  knee: Vec;
  hip: Vec;
  shoulder: Vec;
  elbow: Vec;
  wrist: Vec;
  fingers: Vec;
  head: Vec;
}

export interface PoseParams {
  /** Shoulder–elbow–wrist angle, degrees. */
  elbow: number;
  /** How far the hips leave the straight line, degrees: positive sags, negative pikes. */
  hipBend?: number;
  /** How far the head drops from a neutral neck, degrees. */
  headDrop?: number;
}

const ANKLE_HEIGHT = 8;
const SHIN = 44;
const LEG = 88;
const TORSO = 52;
const UPPER_ARM = 30;
const FOREARM = 28;
const WRIST_HEIGHT = 4;
const NECK = 9;
const FOOT = 6;
const HAND = 9;
// A neutral neck looks at the floor a little ahead of the hands, not straight down the body line.
const NECK_LIFT = 8;

export const HEAD_RADIUS = 9.5;

const DEG = Math.PI / 180;
const ANKLE: Vec = { x: 0, y: ANKLE_HEIGHT };

/** Third side of a triangle from two sides and the angle between them. */
function lawOfCosines(a: number, b: number, degrees: number): number {
  return Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(degrees * DEG));
}

// Hands are planted where the shoulder sits with straight arms and a straight body.
const WRIST: Vec = {
  x: Math.sqrt((LEG + TORSO) ** 2 - (WRIST_HEIGHT + UPPER_ARM + FOREARM - ANKLE_HEIGHT) ** 2),
  y: WRIST_HEIGHT,
};

const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (v: Vec, k: number): Vec => ({ x: v.x * k, y: v.y * k });

/**
 * The two points at distance `r0` from `c0` and `r1` from `c1`, left then right of the line from
 * `c0` to `c1`. Circles that don't meet give the same point, on the line between them, twice.
 */
export function intersectCircles(c0: Vec, r0: number, c1: Vec, r1: number): [Vec, Vec] {
  const d = distance(c0, c1);
  const along = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const half = Math.sqrt(Math.max(0, r0 * r0 - along * along));
  const dir = scale(sub(c1, c0), 1 / d);
  const mid = add(c0, scale(dir, along));
  const normal = { x: -dir.y, y: dir.x };
  return [add(mid, scale(normal, half)), add(mid, scale(normal, -half))];
}

/**
 * Places every joint for the given angles. Toes and hands stay planted; the body pivots at the
 * ankle, and the shoulder sits where the bent arm meets the body's reach from the ankle.
 */
export function solvePose({ elbow, hipBend = 0, headDrop = 0 }: PoseParams): Skeleton {
  const armSpan = lawOfCosines(UPPER_ARM, FOREARM, elbow);
  const bodySpan = lawOfCosines(LEG, TORSO, 180 - Math.abs(hipBend));
  const [shoulder] = intersectCircles(ANKLE, bodySpan, WRIST, armSpan);

  // Left of the ankle→shoulder line is above it: a pike.
  const [above, below] = intersectCircles(ANKLE, LEG, shoulder, TORSO);
  const hip = hipBend < 0 ? above : below;

  // The elbow bends back towards the feet.
  const [front, back] = intersectCircles(shoulder, UPPER_ARM, WRIST, FOREARM);
  const elbowPoint = distance(front, ANKLE) < distance(back, ANKLE) ? front : back;

  const torso = Math.atan2(shoulder.y - hip.y, shoulder.x - hip.x);
  const neck = torso + (NECK_LIFT - headDrop) * DEG;
  const head = add(shoulder, scale({ x: Math.cos(neck), y: Math.sin(neck) }, NECK + HEAD_RADIUS));

  return {
    toe: { x: FOOT, y: 0 },
    ankle: ANKLE,
    knee: add(ANKLE, scale(sub(hip, ANKLE), SHIN / LEG)),
    hip,
    shoulder,
    elbow: elbowPoint,
    wrist: WRIST,
    fingers: { x: WRIST.x + HAND, y: 0.5 },
    head,
  };
}
