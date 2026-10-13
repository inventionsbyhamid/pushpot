export interface RepSummary {
  start: number;
  bottom: number;
  end: number;
  min_elbow: number;
  max_elbow: number;
  min_body: number;
  vis: number;
}

export interface Telemetry {
  v: 1;
  workout_id: string;
  /** Front: no body line, and the elbow channel is the angle the shoulders' drop implies. */
  view: "side" | "front";
  model: string;
  delegate: "GPU" | "CPU";
  video: { w: number; h: number };
  duration_ms: number;
  reps: RepSummary[];
  /** Base64-encoded Uint8Arrays, one sample per processed frame. */
  trace: { dt: string; elbow: string; body: string; vis: string };
}

export interface WorkoutResult {
  reps: number;
  telemetry: Telemetry;
}
