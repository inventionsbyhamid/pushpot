import { clamp } from "./geometry";
import type { RepSummary, Telemetry } from "./types";

/** Largest frame interval a trace can express; also the most a stalled clock may advance per frame. */
export const MAX_FRAME_DT_MS = 255;

export interface TelemetrySample {
  /** Milliseconds on the workout clock. */
  t: number;
  elbow: number;
  body: number;
  /** Mean landmark visibility, 0–1. */
  vis: number;
}

export interface TelemetryMeta {
  workoutId: string;
  view: Telemetry["view"];
  model: string;
  delegate: Telemetry["delegate"];
  video: Telemetry["video"];
  /** Reps timed on the same clock as the samples. */
  reps: readonly RepSummary[];
}

export interface TelemetryRecorder {
  record(sample: TelemetrySample): void;
  readonly length: number;
  build(meta: TelemetryMeta): Telemetry;
}

export function createTelemetryRecorder(): TelemetryRecorder {
  const dt: number[] = [];
  const elbow: number[] = [];
  const body: number[] = [];
  const vis: number[] = [];
  let origin: number | null = null;
  let last = 0;

  return {
    record(sample) {
      const t = Math.round(sample.t);
      origin ??= t;
      dt.push(dt.length === 0 ? 0 : clamp(t - last, 0, MAX_FRAME_DT_MS));
      elbow.push(Math.round(clamp(sample.elbow, 0, 180)));
      body.push(Math.round(clamp(sample.body, 0, 180)));
      vis.push(Math.round(clamp(sample.vis, 0, 1) * 255));
      last = t;
    },

    get length() {
      return dt.length;
    },

    build({ workoutId, view, model, delegate, video, reps }) {
      const t0 = origin ?? 0;
      const since = (t: number) => Math.max(0, Math.round(t - t0));
      return {
        v: 1,
        workout_id: workoutId,
        view,
        model,
        delegate,
        video,
        duration_ms: origin === null ? 0 : last - origin,
        reps: reps.map((rep) => ({
          start: since(rep.start),
          bottom: since(rep.bottom),
          end: since(rep.end),
          min_elbow: Math.round(rep.min_elbow),
          max_elbow: Math.round(rep.max_elbow),
          min_body: Math.round(rep.min_body),
          vis: Math.round(rep.vis * 100) / 100,
        })),
        trace: {
          dt: encodeBase64(Uint8Array.from(dt)),
          elbow: encodeBase64(Uint8Array.from(elbow)),
          body: encodeBase64(Uint8Array.from(body)),
          vis: encodeBase64(Uint8Array.from(vis)),
        },
      };
    },
  };
}

/**
 * A clock that follows wall time but advances at most `MAX_FRAME_DT_MS` between frames, so a
 * backgrounded tab or a model reload doesn't open a gap the trace can't account for.
 */
export function createWorkoutClock(): { tick(now: number): number } {
  let previous: number | null = null;
  let elapsed = 0;
  return {
    tick(now) {
      if (previous !== null) elapsed += clamp(now - previous, 0, MAX_FRAME_DT_MS);
      previous = now;
      return elapsed;
    },
  };
}

const CHUNK = 0x8000;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
