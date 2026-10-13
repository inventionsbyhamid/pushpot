import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark } from "./landmarks";

export const POSE_MODEL = "pose_landmarker_lite";

const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = `/mediapipe/${POSE_MODEL}.task`;

export type Delegate = "GPU" | "CPU";

export interface PoseDetector {
  readonly delegate: Delegate;
  /** Landmarks of the most prominent pose, or null when nobody is detected. */
  detect(video: HTMLVideoElement, now: number): Landmark[] | null;
  close(): void;
}

let fileset: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null;

function loadFileset() {
  fileset ??= FilesetResolver.forVisionTasks(WASM_PATH).catch((error: unknown) => {
    fileset = null;
    throw error;
  });
  return fileset;
}

/** Loads the pose model, preferring the GPU delegate and falling back to the CPU. */
export async function createPoseDetector(preferred: Delegate = "GPU"): Promise<PoseDetector> {
  const wasm = await loadFileset();
  const delegates: Delegate[] = preferred === "GPU" ? ["GPU", "CPU"] : ["CPU"];
  let failure: unknown;

  for (const delegate of delegates) {
    try {
      const landmarker = await PoseLandmarker.createFromOptions(wasm, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        // Without an explicit canvas MediaPipe falls back to an OffscreenCanvas, which lacks
        // WebGL2 on older iOS. Each attempt gets a fresh one in case a failed GPU init tainted it.
        canvas: document.createElement("canvas"),
        runningMode: "VIDEO",
        numPoses: 1,
      });
      return wrap(landmarker, delegate);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function wrap(landmarker: PoseLandmarker, delegate: Delegate): PoseDetector {
  let lastTimestamp = -1;
  return {
    delegate,
    detect(video, now) {
      // VIDEO mode rejects timestamps that don't strictly increase.
      lastTimestamp = Math.max(lastTimestamp + 1, Math.round(now));
      const result = landmarker.detectForVideo(video, lastTimestamp);
      return result.landmarks[0] ?? null;
    },
    close() {
      landmarker.close();
    },
  };
}
