import { distance, isInFrame, toPixels } from "./geometry";
import { jointIndex, visibilityOf, type Joint, type Landmark, type Side } from "./landmarks";

/**
 * Where the camera stands. Side on, the counter reads the elbow angle and the body line. Face
 * on, it reads how far the shoulders drop towards the hands; the hips hide behind them.
 */
export type View = "side" | "front";

export interface SetupChecks {
  /** Every joint the counter reads from this view is clearly visible and inside the frame. */
  inFrame: boolean;
  /** Arms extended and, side on, body straight. */
  plank: boolean;
}

/** Landmarks within this fraction of a frame edge count as outside it. */
export const FRAME_MARGIN = 0.02;

const SETUP_VISIBILITY = 0.6;
// Shoulder width over arm length is near zero side on and well over half face on. Between the
// two bounds the view stays as it was, so it doesn't flicker.
const FRONT_FROM = 0.45;
const SIDE_UNTIL = 0.35;
const SIDES: readonly Side[] = ["left", "right"];
const ARM: readonly Joint[] = ["shoulder", "elbow", "wrist"];
const MISSING: Landmark = { x: 0, y: 0, z: 0, visibility: 0 };

function framed(landmark: Landmark | undefined): boolean {
  return landmark !== undefined && visibilityOf(landmark) >= SETUP_VISIBILITY && isInFrame(landmark, FRAME_MARGIN);
}

/** Side on: the near arm, hip, and an ankle or, with the feet out of shot, a knee. Face on: both arms. */
export function isFramed(pose: readonly Landmark[], view: View, side: Side): boolean {
  const at = (s: Side, joint: Joint) => pose[jointIndex(s, joint)];
  if (view === "front") return SIDES.every((s) => ARM.every((joint) => framed(at(s, joint))));
  const body = [...ARM, "hip" as const].every((joint) => framed(at(side, joint)));
  return body && (framed(at(side, "ankle")) || framed(at(side, "knee")));
}

/** Shoulder width relative to arm length, which tells a front view from a side view. */
export function shoulderSpread(pose: readonly Landmark[], width: number, height: number): number {
  const px = (side: Side, joint: Joint) => toPixels(pose[jointIndex(side, joint)] ?? MISSING, width, height);
  const spread = distance(px("left", "shoulder"), px("right", "shoulder"));
  const reach = (side: Side) => distance(px(side, "shoulder"), px(side, "wrist"));
  const arm = (reach("left") + reach("right")) / 2;
  return arm > 0 ? spread / arm : 0;
}

export function nextView(current: View | null, spread: number): View {
  if (spread >= FRONT_FROM) return "front";
  if (spread <= SIDE_UNTIL) return "side";
  return current ?? "side";
}
