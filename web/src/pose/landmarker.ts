import { FilesetResolver, PoseLandmarker, type ImageSource } from "@mediapipe/tasks-vision";
import { MODEL_PATH, WASM_PATH } from "./assets";
import type { Delegate, PoseDetector } from "./detector";
import type { Landmark } from "./landmarks";

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export interface Landmarker {
  readonly delegate: Delegate;
  detect(image: ImageSource, timestamp: number): Landmark[] | null;
  close(): void;
}

/**
 * Creates the pose landmarker, preferring the GPU delegate and falling back to the CPU, then
 * runs it once on a blank frame so any warm-up happens behind the intro screen rather than on
 * the first camera frame.
 */
export async function loadLandmarker(
  wasm: WasmFileset,
  preferred: Delegate,
  createCanvas: () => HTMLCanvasElement | OffscreenCanvas,
): Promise<Landmarker> {
  const delegates: Delegate[] = preferred === "GPU" ? ["GPU", "CPU"] : ["CPU"];
  let failure: unknown;

  for (const delegate of delegates) {
    let landmarker: PoseLandmarker | undefined;
    try {
      landmarker = await PoseLandmarker.createFromOptions(wasm, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        // Passed explicitly: MediaPipe otherwise picks a canvas by user agent, which goes wrong on
        // older iOS and in workers. Each attempt gets a fresh one in case a failed GPU init tainted it.
        canvas: createCanvas(),
        runningMode: "VIDEO",
        numPoses: 1,
      });
      const wrapped = wrap(landmarker, delegate);
      wrapped.detect(new ImageData(256, 256), 0);
      return wrapped;
    } catch (error) {
      landmarker?.close();
      failure = error;
    }
  }
  throw failure;
}

function wrap(landmarker: PoseLandmarker, delegate: Delegate): Landmarker {
  let lastTimestamp = -1;
  return {
    delegate,
    detect(image, timestamp) {
      // VIDEO mode rejects timestamps that don't strictly increase.
      lastTimestamp = Math.max(lastTimestamp + 1, Math.round(timestamp));
      return landmarker.detectForVideo(image, lastTimestamp).landmarks[0] ?? null;
    },
    close() {
      landmarker.close();
    },
  };
}

/** Runs the model on the main thread, for browsers that can't run it in a worker. */
export async function createMainThreadDetector(preferred: Delegate): Promise<PoseDetector> {
  const wasm = await FilesetResolver.forVisionTasks(WASM_PATH);
  const landmarker = await loadLandmarker(wasm, preferred, () => document.createElement("canvas"));
  return {
    delegate: landmarker.delegate,
    mode: "main",
    async detect(video, timestamp) {
      const start = performance.now();
      const landmarks = landmarker.detect(video, timestamp);
      return { landmarks, inferenceMs: performance.now() - start };
    },
    close() {
      landmarker.close();
    },
  };
}
