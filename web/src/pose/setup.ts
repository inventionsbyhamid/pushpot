import { distance, isInFrame, toPixels } from "./geometry";
import { jointIndex, otherSide, visibilityOf, type Joint, type Landmark, type Side } from "./landmarks";

export interface SetupChecks {
  /** Near-side shoulder, elbow, wrist, hip and ankle are clearly visible and inside the frame. */
  inFrame: boolean;
  /** The body is side-on to the camera. */
  sideOn: boolean;
  /** Arms extended and body straight. */
  plank: boolean;
}

/** Landmarks within this fraction of a frame edge count as outside it. */
export const FRAME_MARGIN = 0.02;

const SETUP_VISIBILITY = 0.6;
const MAX_SHOULDER_SPREAD = 0.8;
const FRAMING_JOINTS: readonly Joint[] = ["shoulder", "elbow", "wrist", "hip", "ankle"];

export function checkFraming(
  pose: readonly Landmark[],
  side: Side,
  width: number,
  height: number,
): Omit<SetupChecks, "plank"> {
  const inFrame = FRAMING_JOINTS.every((joint) => {
    const landmark = pose[jointIndex(side, joint)];
    return landmark !== undefined && visibilityOf(landmark) >= SETUP_VISIBILITY && isInFrame(landmark, FRAME_MARGIN);
  });

  const shoulder = pose[jointIndex(side, "shoulder")];
  const farShoulder = pose[jointIndex(otherSide(side), "shoulder")];
  const hip = pose[jointIndex(side, "hip")];
  if (!shoulder || !farShoulder || !hip) return { inFrame, sideOn: false };

  const spread = distance(toPixels(shoulder, width, height), toPixels(farShoulder, width, height));
  const torso = distance(toPixels(shoulder, width, height), toPixels(hip, width, height));
  return { inFrame, sideOn: torso > 0 && spread / torso < MAX_SHOULDER_SPREAD };
}
