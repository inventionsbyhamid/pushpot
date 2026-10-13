const WINDOW = 60;

/** Rolling frame rate and inference time of the pose loop, for the `?debug` HUD. */
export class PerfStats {
  private readonly times = new Float64Array(WINDOW);
  private readonly costs = new Float64Array(WINDOW);
  private count = 0;

  record(now: number, inferenceMs: number): void {
    const slot = this.count % WINDOW;
    this.times[slot] = now;
    this.costs[slot] = inferenceMs;
    this.count += 1;
  }

  /** Frames processed in the last second. */
  fps(now: number): number {
    return this.times.subarray(0, Math.min(this.count, WINDOW)).filter((t) => now - t <= 1000).length;
  }

  inferenceP50(): number | null {
    const recent = this.costs.slice(0, Math.min(this.count, WINDOW)).sort();
    return recent.length === 0 ? null : (recent[recent.length >> 1] ?? null);
  }
}
