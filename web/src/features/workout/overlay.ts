import { BODY_CONNECTIONS, jointIndex, visibilityOf, type Joint, type Landmark, type Side } from "../../pose/landmarks";

const MIN_VISIBILITY = 0.3;
const NEAR_JOINTS: readonly Joint[] = ["shoulder", "elbow", "wrist", "hip", "knee", "ankle", "foot"];

export interface OverlayColors {
  valid: string;
  invalid: string;
  joint: string;
}

/** Draws the skeleton in video pixel space; the canvas is sized to the video frame. */
export function drawSkeleton(
  canvas: HTMLCanvasElement,
  landmarks: readonly Landmark[] | null,
  side: Side,
  valid: boolean,
  colors: OverlayColors,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!landmarks) return;

  const near = new Set(NEAR_JOINTS.map((joint) => jointIndex(side, joint)));
  const scale = Math.min(width, height);
  ctx.lineCap = "round";
  ctx.strokeStyle = valid ? colors.valid : colors.invalid;

  for (const [from, to] of BODY_CONNECTIONS) {
    const a = landmarks[from];
    const b = landmarks[to];
    if (!a || !b || visibilityOf(a) < MIN_VISIBILITY || visibilityOf(b) < MIN_VISIBILITY) continue;
    const highlighted = near.has(from) && near.has(to);
    ctx.globalAlpha = highlighted ? 1 : 0.35;
    ctx.lineWidth = scale * (highlighted ? 0.016 : 0.008);
    ctx.beginPath();
    ctx.moveTo(a.x * width, a.y * height);
    ctx.lineTo(b.x * width, b.y * height);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.joint;
  ctx.lineWidth = scale * 0.006;
  for (const index of near) {
    const point = landmarks[index];
    if (!point || visibilityOf(point) < MIN_VISIBILITY) continue;
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, scale * 0.014, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
