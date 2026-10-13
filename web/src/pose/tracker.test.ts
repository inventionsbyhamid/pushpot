import { describe, expect, it } from "vitest";
import { hold, reps, sequence, synthesizeFront } from "./synthetic";
import { decodeBase64 } from "./telemetry";
import { createWorkoutTracker } from "./tracker";

describe("createWorkoutTracker", () => {
  it("marks a workout counted face on, which has no body line", () => {
    const { curve, durationMs } = sequence(hold(170, 1000), reps(4, 1200, 80, 170), hold(170, 1000));
    const tracker = createWorkoutTracker();
    for (const frame of synthesizeFront({ durationMs, elbow: curve })) {
      tracker.push(frame.t, frame.landmarks, frame.width, frame.height);
    }
    const { reps: counted, telemetry } = tracker.result({
      workout_id: "w",
      model: "m",
      delegate: "CPU",
      video: { w: 640, h: 480 },
    });

    expect(counted).toBe(4);
    expect(telemetry.view).toBe("front");
    expect(new Set(decodeBase64(telemetry.trace.body))).toEqual(new Set([180]));
  });
});
