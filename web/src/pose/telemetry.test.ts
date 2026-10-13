import { describe, expect, it } from "vitest";
import { hold, reps, sequence, synthesize } from "./synthetic";
import { createTelemetryRecorder, createWorkoutClock, decodeBase64, encodeBase64, MAX_FRAME_DT_MS } from "./telemetry";
import { createWorkoutTracker } from "./tracker";

const META = {
  workout_id: "w-1",
  model: "pose_landmarker_lite",
  delegate: "GPU" as const,
  video: { w: 640, h: 480 },
};

const sum = (bytes: Uint8Array) => bytes.reduce((a, b) => a + b, 0);

describe("base64", () => {
  it("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
    expect(encodeBase64(Uint8Array.from([255, 0, 128]))).toBe("/wCA");
  });
});

describe("createTelemetryRecorder", () => {
  it("caps frame intervals and keeps channels aligned", () => {
    const recorder = createTelemetryRecorder();
    const times = [1000, 1033, 1066, 1600, 1633];
    for (const t of times) recorder.record({ t, elbow: 200, body: 170.4, vis: 0.9 });
    const telemetry = recorder.build({ workoutId: "w", model: "m", delegate: "CPU", video: { w: 640, h: 480 }, reps: [] });

    const dt = decodeBase64(telemetry.trace.dt);
    expect(Array.from(dt)).toEqual([0, 33, 33, MAX_FRAME_DT_MS, 33]);
    expect(Array.from(decodeBase64(telemetry.trace.elbow))).toEqual([180, 180, 180, 180, 180]);
    expect(Array.from(decodeBase64(telemetry.trace.body))).toEqual([170, 170, 170, 170, 170]);
    expect(Array.from(decodeBase64(telemetry.trace.vis))).toEqual([230, 230, 230, 230, 230]);
    expect(telemetry.duration_ms).toBe(633);
  });
});

describe("createWorkoutClock", () => {
  it("follows wall time but skips over stalls", () => {
    const clock = createWorkoutClock();
    expect([1000, 1033, 31_033, 31_066].map((now) => clock.tick(now))).toEqual([0, 33, 288, 321]);
  });
});

describe("createWorkoutTracker", () => {
  it("produces a consistent trace for a real session", () => {
    const { curve, durationMs } = sequence(hold(165, 1500), reps(8, 1300, 82, 166, 200), hold(165, 1000));
    const frames = synthesize({ durationMs, elbow: curve, jitterPx: 1, seed: 2 });
    const tracker = createWorkoutTracker();
    const wallStart = 50_000;
    frames.forEach((frame, i) => {
      // Simulate the app being backgrounded for 20 s halfway through.
      const now = wallStart + frame.t + (i > frames.length / 2 ? 20_000 : 0);
      tracker.push(now, frame.landmarks, frame.width, frame.height);
    });
    const { reps: count, telemetry } = tracker.result(META);

    expect(count).toBe(8);
    expect(telemetry.reps).toHaveLength(8);
    const dt = decodeBase64(telemetry.trace.dt);
    const elbow = decodeBase64(telemetry.trace.elbow);
    for (const channel of [elbow, decodeBase64(telemetry.trace.body), decodeBase64(telemetry.trace.vis)]) {
      expect(channel.length).toBe(dt.length);
    }
    expect(Math.abs(sum(dt) - telemetry.duration_ms)).toBeLessThanOrEqual(telemetry.duration_ms * 0.01);
    expect(Math.max(...dt)).toBeLessThanOrEqual(MAX_FRAME_DT_MS);

    let previousEnd = -Infinity;
    for (const rep of telemetry.reps) {
      expect(rep.start).toBeGreaterThan(previousEnd);
      expect(rep.end).toBeLessThanOrEqual(telemetry.duration_ms);
      previousEnd = rep.end;
    }
    expect(Math.min(...elbow)).toBeLessThanOrEqual(100);
    expect(Math.max(...elbow)).toBeGreaterThanOrEqual(150);
  });

  it("returns an empty trace when counting never started", () => {
    const tracker = createWorkoutTracker();
    tracker.push(0, [], 640, 480);
    const { reps: count, telemetry } = tracker.result(META);
    expect(count).toBe(0);
    expect(telemetry.duration_ms).toBe(0);
    expect(telemetry.trace.dt).toBe("");
  });
});
