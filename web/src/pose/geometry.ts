export interface Point {
  x: number;
  y: number;
}

const DEG_PER_RAD = 180 / Math.PI;

/** Converts a normalized landmark to pixels so angles aren't skewed by the frame's aspect ratio. */
export function toPixels(point: Point, width: number, height: number): Point {
  return { x: point.x * width, y: point.y * height };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Interior angle a–vertex–c in degrees, 0–180. */
export function angleAt(a: Point, vertex: Point, c: Point): number {
  const ux = a.x - vertex.x;
  const uy = a.y - vertex.y;
  const vx = c.x - vertex.x;
  const vy = c.y - vertex.y;
  return Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy) * DEG_PER_RAD;
}

/**
 * Perpendicular distance from `p` to the line through `a` and `b`, positive when `p` lies
 * below the line in image coordinates (y grows downwards).
 */
export function offsetFromLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const cross = dx * (p.y - a.y) - dy * (p.x - a.x);
  return (cross / length) * (dx >= 0 ? 1 : -1);
}

/** Whether a normalized point lies inside the frame, at least `margin` from every edge. */
export function isInFrame(point: Point, margin: number): boolean {
  return point.x >= margin && point.x <= 1 - margin && point.y >= margin && point.y <= 1 - margin;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
