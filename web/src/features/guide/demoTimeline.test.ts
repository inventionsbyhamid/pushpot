import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  demoSteps,
  DOWN_ANGLE,
  frameAt,
  MIN_BODY_ANGLE,
  TARGET,
  UP_ANGLE,
  type DemoFrame,
} from "./demoTimeline";

const timeline = buildTimeline();

function sample(from: number, to: number): DemoFrame[] {
  const frames: DemoFrame[] = [];
  for (let t = from; t < to; t += 10) frames.push(frameAt(timeline, t));
  return frames;
}

const deepest = (frames: DemoFrame[]) => Math.min(...frames.map((f) => f.elbow));
const worstBodyLine = (frames: DemoFrame[]) => 180 - Math.max(...frames.map((f) => f.bend));

describe("demo timeline", () => {
  it("counts only the clean reps and finishes on the target", () => {
    expect(timeline.counts).toHaveLength(timeline.reps.filter((r) => r.kind === "clean").length);
    expect(frameAt(timeline, 0).count).toBe(TARGET - timeline.counts.length);
    expect(frameAt(timeline, timeline.success.from + 500)).toMatchObject({ count: TARGET, success: 1 });
  });

  it("follows the counter's rules on every rep", () => {
    for (const rep of timeline.reps) {
      const frames = sample(rep.start, rep.end + 1);
      const counted = timeline.counts.includes(rep.end);

      expect(counted).toBe(deepest(frames) <= DOWN_ANGLE && worstBodyLine(frames) >= MIN_BODY_ANGLE);
      expect(rep.end - rep.start).toBeGreaterThanOrEqual(500);
      expect(frameAt(timeline, rep.end).elbow).toBeCloseTo(UP_ANGLE, 6);
    }
  });

  it("stops the half rep near 125° and cues it", () => {
    const half = timeline.reps.find((r) => r.kind === "half")!;
    expect(deepest(sample(half.start, half.end))).toBeCloseTo(125, 0);
    expect(frameAt(timeline, half.bottom + 50).cue).toBe("lower");
    expect(frameAt(timeline, half.end + 50).noRep).toBe(true);
  });

  it("sags the hips to about 130° and cues it", () => {
    const sag = timeline.reps.find((r) => r.kind === "sag")!;
    expect(worstBodyLine(sample(sag.start, sag.end))).toBeCloseTo(130, 0);
    expect(frameAt(timeline, sag.bottom).cue).toBe("straight");
    expect(frameAt(timeline, sag.end + 50).count).toBe(frameAt(timeline, sag.start).count);
  });

  it("pulses when a rep counts", () => {
    const at = timeline.counts[0]!;
    expect(frameAt(timeline, at).pulse).toBe(1);
    expect(frameAt(timeline, at + 1000).pulse).toBe(0);
  });

  it("loops back to where it started", () => {
    const start = frameAt(timeline, 0);
    const end = frameAt(timeline, timeline.duration - 1);
    expect(end.count).toBe(start.count);
    expect(end.elbow).toBeCloseTo(start.elbow, 6);
    expect(end.bend).toBeCloseTo(start.bend, 6);
    expect(end.success).toBeLessThan(0.01);
  });

  it("has still frames in story order", () => {
    const times = demoSteps(timeline).map((step) => step.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times.every((t) => t >= 0 && t < timeline.duration)).toBe(true);
  });
});
