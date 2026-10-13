import { OneEuroFilter, type OneEuroOptions } from "../../pose/filters";
import {
  BODY_CONNECTIONS,
  BODY_LANDMARKS,
  jointIndex,
  POSE_LANDMARK_COUNT,
  visibilityOf,
  type Joint,
  type Landmark,
  type Side,
} from "../../pose/landmarks";
import type { View } from "../../pose/setup";

// Tuned on recorded landmarks: about a third less jitter at rest with no visible lag in motion.
// Positions are filtered in units of the frame's shorter side.
const DISPLAY_FILTER: OneEuroOptions = { minCutoff: 3, beta: 8, dCutoff: 1 };
const MIN_VISIBILITY = 0.35;
const FULL_VISIBILITY = 0.75;
const FADE_MS = 300;
// Landmarks are drawn at a few opacity levels so each level is one path: a handful of draw calls
// per frame instead of one per bone keeps the GPU free for inference.
const LEVELS = 4;
const TRACKED_BONES: readonly (readonly [Joint, Joint])[] = [
  ["shoulder", "elbow"],
  ["elbow", "wrist"],
  ["shoulder", "hip"],
  ["hip", "knee"],
  ["knee", "ankle"],
];

export interface OverlayColors {
  /** The tracked arm and body line while the counter can read them. */
  active: string;
  /** The tracked arm and body line while it can't. */
  inactive: string;
  bone: string;
  ink: string;
}

export interface PoseSample {
  landmarks: readonly Landmark[] | null;
  /** Frame time in milliseconds, for the smoothing filters. */
  time: number;
  /** Source frame size, so smoothing treats x and y alike. */
  width: number;
  height: number;
  side: Side;
  view: View;
  valid: boolean;
  /** Elbow angle the counter is using, in degrees. */
  elbow: number | null;
}

export interface OverlayView {
  /** Canvas size in CSS pixels; the canvas covers exactly the displayed video. */
  width: number;
  height: number;
  dpr: number;
  mirrored: boolean;
  colors: OverlayColors;
}

export interface PoseOverlay {
  /** Feeds a detection; `now` is when it arrived, on the animation clock. */
  push(sample: PoseSample, now: number): void;
  /** Draws the pose as of `now`, gliding between detections. Does nothing while at rest. */
  draw(ctx: CanvasRenderingContext2D, view: OverlayView, now: number): void;
  reset(): void;
}

interface Point {
  readonly index: number;
  readonly filterX: OneEuroFilter;
  readonly filterY: OneEuroFilter;
  /** Normalized positions the glide runs between. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  visibility: number;
  /** Where it was last drawn, in CSS pixels, and its opacity level (0 when hidden). */
  x: number;
  y: number;
  level: number;
}

type Bone = readonly [Point, Point];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * The skeleton drawn over the camera: every body landmark, smoothed for display (the counter
 * smooths its own angles separately) and interpolated so motion stays fluid when detections
 * arrive slower than the display refreshes.
 */
export function createPoseOverlay(): PoseOverlay {
  const points = BODY_LANDMARKS.map(
    (index): Point => ({
      index,
      filterX: new OneEuroFilter(DISPLAY_FILTER),
      filterY: new OneEuroFilter(DISPLAY_FILTER),
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      visibility: 0,
      x: 0,
      y: 0,
      level: 0,
    }),
  );
  const point = (index: number): Point => {
    const found = points.find((p) => p.index === index);
    if (!found) throw new Error(`landmark ${index} is not drawn`);
    return found;
  };
  const bones: Bone[] = BODY_CONNECTIONS.map(([a, b]) => [point(a), point(b)]);
  const highlight = (side: Side) => {
    const joints = new Set(TRACKED_BONES.flat().map((joint) => point(jointIndex(side, joint))));
    return {
      bones: TRACKED_BONES.map(([a, b]): Bone => [point(jointIndex(side, a)), point(jointIndex(side, b))]),
      joints: [...joints],
      others: points.filter((p) => !joints.has(p)),
      arm: [point(jointIndex(side, "shoulder")), point(jointIndex(side, "elbow")), point(jointIndex(side, "wrist"))] as const,
    };
  };
  const tracked = { left: highlight("left"), right: highlight("right") };
  // Face on, the counter reads both arms and the shoulders between them.
  const front = (() => {
    const arms = (["left", "right"] as const).flatMap((s) => [
      [point(jointIndex(s, "shoulder")), point(jointIndex(s, "elbow"))] as const,
      [point(jointIndex(s, "elbow")), point(jointIndex(s, "wrist"))] as const,
    ]);
    const bridge = [point(jointIndex("left", "shoulder")), point(jointIndex("right", "shoulder"))] as const;
    const joints = new Set(arms.flat());
    return { bones: [...arms, bridge], joints: [...joints], others: points.filter((p) => !joints.has(p)) };
  })();

  let shown = false;
  let lostAt: number | null = null;
  let startedAt = 0;
  let lastPushAt: number | null = null;
  let span = 33;
  let side: Side = "left";
  let facing: View = "side";
  let valid = false;
  let elbow: number | null = null;
  let dirty = true;
  let lastView: OverlayView | null = null;
  let lastWidth = 0;
  let lastHeight = 0;

  const progressAt = (now: number) => clamp01((now - startedAt) / span);

  function resetFilters(): void {
    for (const p of points) {
      p.filterX.reset();
      p.filterY.reset();
    }
  }

  function push(sample: PoseSample, now: number): void {
    dirty = true;
    const pose = sample.landmarks;
    if (!pose || pose.length < POSE_LANDMARK_COUNT) {
      if (shown && lostAt === null) lostAt = now;
      lastPushAt = null;
      resetFilters();
      return;
    }

    // Glide on from wherever the skeleton is drawn now, unless it is (re)appearing.
    const fresh = !shown || lostAt !== null;
    const progress = progressAt(now);
    const unit = Math.min(sample.width, sample.height);
    const sx = sample.width / unit;
    const sy = sample.height / unit;
    for (const p of points) {
      const landmark = pose[p.index];
      if (!landmark) continue;
      const x = p.filterX.filter(landmark.x * sx, sample.time) / sx;
      const y = p.filterY.filter(landmark.y * sy, sample.time) / sy;
      const visibility = visibilityOf(landmark);
      p.fromX = fresh ? x : p.fromX + (p.toX - p.fromX) * progress;
      p.fromY = fresh ? y : p.fromY + (p.toY - p.fromY) * progress;
      p.toX = x;
      p.toY = y;
      p.visibility = fresh ? visibility : p.visibility + 0.5 * (visibility - p.visibility);
    }

    // Each glide lasts about as long as the gap between detections.
    if (lastPushAt !== null) span += 0.3 * (Math.min(120, Math.max(16, now - lastPushAt)) - span);
    lastPushAt = now;
    startedAt = now;
    shown = true;
    lostAt = null;
    side = sample.side;
    facing = sample.view;
    valid = sample.valid;
    elbow = sample.elbow;
  }

  function draw(ctx: CanvasRenderingContext2D, view: OverlayView, now: number): void {
    const { canvas } = ctx;
    const resized = view !== lastView || canvas.width !== lastWidth || canvas.height !== lastHeight;
    if (!dirty && !resized) return;
    lastView = view;
    lastWidth = canvas.width;
    lastHeight = canvas.height;

    const progress = progressAt(now);
    const fade = lostAt === null ? 1 : 1 - (now - lostAt) / FADE_MS;
    dirty = progress < 1 || (lostAt !== null && fade > 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!shown || fade <= 0 || view.width === 0) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    // Stroke sizes follow the displayed video, within limits that stay legible on any screen.
    const unit = Math.min(6, Math.max(2.5, Math.min(view.width, view.height) / 100));
    for (const p of points) {
      const x = p.fromX + (p.toX - p.fromX) * progress;
      const y = p.fromY + (p.toY - p.fromY) * progress;
      p.x = (view.mirrored ? 1 - x : x) * view.width;
      p.y = y * view.height;
      p.level = Math.ceil(clamp01((p.visibility - MIN_VISIBILITY) / (FULL_VISIBILITY - MIN_VISIBILITY)) * LEVELS);
    }

    const { colors } = view;
    const highlighted = facing === "front" ? front : tracked[side];
    const accent = valid ? colors.active : colors.inactive;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // The whole skeleton, quiet; then the arm and body line the counter reads, over a soft glow.
    ctx.strokeStyle = colors.bone;
    ctx.lineWidth = unit * 0.55;
    strokeBones(ctx, bones, fade * 0.6);
    ctx.strokeStyle = accent;
    ctx.lineWidth = unit * 2.6;
    strokeBones(ctx, highlighted.bones, fade * 0.22);
    ctx.lineWidth = unit * 1.1;
    strokeBones(ctx, highlighted.bones, fade);

    ctx.strokeStyle = colors.ink;
    ctx.fillStyle = colors.bone;
    ctx.lineWidth = unit * 0.35;
    drawJoints(ctx, highlighted.others, unit * 0.75, fade);
    ctx.fillStyle = accent;
    ctx.lineWidth = unit * 0.5;
    drawJoints(ctx, highlighted.joints, unit * 1.25, fade);

    // Face on, the angle comes from the shoulders' drop rather than any one arm, so it isn't drawn.
    if (valid && elbow !== null && facing === "side") {
      drawElbowAngle(ctx, tracked[side].arm, elbow, unit, accent, colors.ink, fade);
    }
    ctx.globalAlpha = 1;
  }

  return {
    push,
    draw,
    reset() {
      shown = false;
      lostAt = null;
      lastPushAt = null;
      dirty = true;
      resetFilters();
    },
  };
}

function strokeBones(ctx: CanvasRenderingContext2D, bones: readonly Bone[], opacity: number): void {
  for (let level = LEVELS; level > 0; level--) {
    ctx.beginPath();
    let any = false;
    for (const [a, b] of bones) {
      if (Math.min(a.level, b.level) !== level) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      any = true;
    }
    if (!any) continue;
    ctx.globalAlpha = (opacity * level) / LEVELS;
    ctx.stroke();
  }
}

function drawJoints(ctx: CanvasRenderingContext2D, joints: readonly Point[], radius: number, opacity: number): void {
  for (let level = LEVELS; level > 0; level--) {
    ctx.beginPath();
    let any = false;
    for (const p of joints) {
      if (p.level !== level) continue;
      ctx.moveTo(p.x + radius, p.y);
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      any = true;
    }
    if (!any) continue;
    ctx.globalAlpha = (opacity * level) / LEVELS;
    ctx.fill();
    ctx.stroke();
  }
}

/** A wedge inside the elbow showing the angle being measured, and its reading. */
function drawElbowAngle(
  ctx: CanvasRenderingContext2D,
  [shoulder, elbow, wrist]: readonly [Point, Point, Point],
  angle: number,
  unit: number,
  accent: string,
  ink: string,
  fade: number,
): void {
  const opacity = (fade * Math.min(shoulder.level, elbow.level, wrist.level)) / LEVELS;
  if (opacity <= 0) return;
  const toShoulder = Math.atan2(shoulder.y - elbow.y, shoulder.x - elbow.x);
  let sweep = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x) - toShoulder;
  if (sweep > Math.PI) sweep -= Math.PI * 2;
  if (sweep < -Math.PI) sweep += Math.PI * 2;

  const radius = unit * 5;
  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  ctx.lineWidth = unit * 0.45;
  ctx.globalAlpha = opacity * 0.2;
  ctx.beginPath();
  ctx.moveTo(elbow.x, elbow.y);
  ctx.arc(elbow.x, elbow.y, radius, toShoulder, toShoulder + sweep, sweep < 0);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.arc(elbow.x, elbow.y, radius, toShoulder, toShoulder + sweep, sweep < 0);
  ctx.stroke();

  // The reading sits outside the bend, drifting upward as the arm straightens.
  const bend = Math.abs(Math.cos(sweep / 2));
  const bisector = toShoulder + sweep / 2;
  const dx = -Math.cos(bisector) * bend;
  const dy = -Math.sin(bisector) * bend - 0.6;
  const length = Math.hypot(dx, dy) || 1;

  const fontSize = Math.round(Math.max(13, unit * 3.6));
  const text = `${Math.round(angle)}°`;
  ctx.font = `800 ${fontSize}px "Big Shoulders Variable", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const boxWidth = ctx.measureText(text).width + fontSize * 0.9;
  const boxHeight = fontSize * 1.35;
  const cx = elbow.x + (dx / length) * (radius + boxWidth * 0.6);
  const cy = elbow.y + (dy / length) * (radius + boxHeight * 0.8);

  ctx.globalAlpha = opacity * 0.88;
  ctx.fillStyle = ink;
  ctx.beginPath();
  // roundRect arrived in Safari 16.
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(cx - boxWidth / 2, cy - boxHeight / 2, boxWidth, boxHeight, boxHeight / 2);
  } else {
    ctx.rect(cx - boxWidth / 2, cy - boxHeight / 2, boxWidth, boxHeight);
  }
  ctx.fill();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = accent;
  ctx.fillText(text, cx, cy);
}
