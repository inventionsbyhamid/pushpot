import type { Landmark } from "./landmarks";
import { createRepCounter, type CounterUpdate } from "./repCounter";
import { createTelemetryRecorder, createWorkoutClock } from "./telemetry";
import type { Telemetry, WorkoutResult } from "./types";

export interface WorkoutTracker {
  /** Feeds one processed video frame; `now` is wall time in milliseconds. */
  push(now: number, landmarks: readonly Landmark[], width: number, height: number): CounterUpdate;
  result(meta: Omit<Telemetry, "v" | "view" | "duration_ms" | "reps" | "trace">): WorkoutResult;
}

/**
 * Runs the rep counter and records telemetry on a shared workout clock. Recording starts once
 * the starting plank is established, so rep times are relative to when counting began.
 */
export function createWorkoutTracker(): WorkoutTracker {
  const clock = createWorkoutClock();
  const counter = createRepCounter();
  const recorder = createTelemetryRecorder();
  let counting = false;
  // Any stretch counted face on has no body line, so the server must not check one.
  let front = false;

  return {
    push(now, landmarks, width, height) {
      const t = clock.tick(now);
      const update = counter.push({ t, landmarks, width, height });
      counting ||= update.phase === "up";
      if (counting) {
        front ||= update.view === "front";
        recorder.record({ t, elbow: update.elbow ?? 0, body: update.body ?? 0, vis: update.vis });
      }
      return update;
    },

    result({ workout_id, model, delegate, video }) {
      const view = front ? "front" : "side";
      const telemetry = recorder.build({ workoutId: workout_id, view, model, delegate, video, reps: counter.reps });
      return { reps: counter.reps.length, telemetry };
    },
  };
}
