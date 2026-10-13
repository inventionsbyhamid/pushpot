import { describe, expect, it } from "vitest";
import { createRepCounter, type PoseFrame } from "./repCounter";
import { hold, ramp, reps, sequence, synthesize } from "./synthetic";

function run(frames: PoseFrame[]) {
  const counter = createRepCounter();
  const updates = frames.map((frame) => counter.push(frame));
  return {
    reps: counter.reps,
    updates,
    count: updates.at(-1)?.count ?? 0,
    cues: new Set(updates.map((u) => u.cue)),
    phases: new Set(updates.map((u) => u.phase)),
  };
}

describe("createRepCounter", () => {
  it("counts clean reps", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), reps(10, 1200, 80, 165), hold(165, 1000));
    const result = run(synthesize({ durationMs, elbow: curve, jitterPx: 1.5, seed: 7 }));

    expect(result.count).toBe(10);
    expect(result.reps).toHaveLength(10);
    for (const rep of result.reps) {
      expect(rep.start).toBeLessThan(rep.bottom);
      expect(rep.bottom).toBeLessThan(rep.end);
      expect(rep.end - rep.start).toBeGreaterThanOrEqual(500);
      expect(rep.min_elbow).toBeLessThanOrEqual(100);
      expect(rep.max_elbow).toBeGreaterThanOrEqual(145);
      expect(rep.min_body).toBeGreaterThanOrEqual(145);
      expect(rep.vis).toBeGreaterThan(0.9);
    }
  });

  it("counts reps seen from the right side", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), reps(3, 1500, 80, 165), hold(165, 1000));
    const result = run(synthesize({ durationMs, elbow: curve, side: "right" }));

    expect(result.count).toBe(3);
    expect(result.updates.at(-1)?.side).toBe("right");
  });

  it("waits in setup until a plank is held", () => {
    const { curve, durationMs } = sequence(hold(90, 2000), hold(165, 400), hold(90, 1000));
    const result = run(synthesize({ durationMs, elbow: curve }));

    expect(result.phases).toEqual(new Set(["setup"]));
    expect(result.cues).toContain("get_in_plank");
    expect(result.count).toBe(0);
  });

  it("does not count shallow reps and cues to go lower", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), reps(5, 1200, 120, 165), hold(165, 1000));
    const result = run(synthesize({ durationMs, elbow: curve }));

    expect(result.count).toBe(0);
    expect(result.cues).toContain("go_lower");
  });

  it("does not count reps faster than the minimum cycle", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), reps(10, 350, 80, 165), hold(165, 1000));
    const result = run(synthesize({ durationMs, elbow: curve }));

    expect(result.count).toBe(0);
  });

  it("does not count reps with sagging hips", () => {
    const { curve, durationMs } = sequence(hold(165, 1500), reps(5, 1200, 80, 165), hold(165, 1000));
    const body = (t: number) => (t < 1500 ? 178 : 130);
    const result = run(synthesize({ durationMs, elbow: curve, body }));

    expect(result.count).toBe(0);
    expect(result.cues).toContain("hips_sag");
  });

  it("cues hips that pike up", () => {
    const { curve, durationMs } = sequence(hold(165, 1500), reps(2, 1200, 80, 165), hold(165, 500));
    const body = (t: number) => (t < 1500 ? 178 : 230);
    const result = run(synthesize({ durationMs, elbow: curve, body }));

    expect(result.count).toBe(0);
    expect(result.cues).toContain("hips_pike");
  });

  it("cues lock out when the user bounces without extending", () => {
    const { curve, durationMs } = sequence(
      hold(165, 1000),
      ramp(165, 80, 600),
      ramp(80, 140, 500),
      ramp(140, 80, 500),
      ramp(80, 165, 600),
      hold(165, 1000),
    );
    const result = run(synthesize({ durationMs, elbow: curve }));

    expect(result.cues).toContain("lock_out");
    expect(result.count).toBe(0);
  });

  it("holds state through a dropout and reports lost", () => {
    const { curve, durationMs } = sequence(
      hold(165, 1000),
      reps(3, 1200, 80, 165),
      hold(165, 3000),
      reps(3, 1200, 80, 165),
      hold(165, 1000),
    );
    const dropout = (t: number) => t >= 5000 && t < 6500;
    const result = run(synthesize({ durationMs, elbow: curve, dropout, seed: 3 }));

    const during = result.updates.filter((_, i) => dropout(i * (1000 / 30)));
    expect(during.some((u) => u.phase === "lost" && u.cue === "move_into_frame")).toBe(true);
    expect(new Set(during.map((u) => u.count))).toEqual(new Set([3]));
    expect(result.count).toBe(6);
  });

  it("does not count a rep hidden by a dropout", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), reps(4, 1200, 80, 165), hold(165, 1000));
    const dropout = (t: number) => t >= 2150 && t < 3650;
    const result = run(synthesize({ durationMs, elbow: curve, dropout, seed: 5 }));

    expect(result.phases).toContain("lost");
    expect(result.count).toBe(3);
  });

  it("does not double count jitter around the lockout threshold", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), hold(150, 3000), reps(5, 1300, 80, 168), hold(150, 3000));
    const result = run(synthesize({ durationMs, elbow: curve, elbowJitter: 4, jitterPx: 1, seed: 11 }));

    expect(result.count).toBe(5);
  });

  it("abandons a rep held at the bottom too long", () => {
    const { curve, durationMs } = sequence(hold(165, 1000), hold(80, 9000), hold(165, 1000));
    const result = run(synthesize({ durationMs, elbow: curve }));

    expect(result.count).toBe(0);
    expect(result.updates.at(-1)?.phase).toBe("up");
  });
});
