/** A MediaPipe normalized landmark: x and y in [0, 1] of the frame width and height. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export type Side = "left" | "right";
export type Joint = "shoulder" | "elbow" | "wrist" | "hip" | "knee" | "ankle" | "foot";

export const POSE_LANDMARK_COUNT = 33;

const JOINTS: Record<Side, Record<Joint, number>> = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, foot: 31 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, foot: 32 },
};

export function jointIndex(side: Side, joint: Joint): number {
  return JOINTS[side][joint];
}

export function otherSide(side: Side): Side {
  return side === "left" ? "right" : "left";
}

export function visibilityOf(landmark: Landmark | undefined): number {
  return landmark?.visibility ?? 0;
}

/** Landmarks worth drawing: the nose, then everything from the shoulders down. */
export const BODY_LANDMARKS: readonly number[] = [0, ...Array.from({ length: 22 }, (_, i) => 11 + i)];

/** Pairs of landmark indices forming the body skeleton (face omitted). */
export const BODY_CONNECTIONS: readonly (readonly [number, number])[] = [
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
];
