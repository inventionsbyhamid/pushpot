import { supportsWorkerDetection } from "./assets";
import type { Landmark } from "./landmarks";

export type Delegate = "GPU" | "CPU";
export type DetectorMode = "worker" | "main";

export interface Detection {
  /** Landmarks of the most prominent pose, or null when nobody is detected. */
  landmarks: Landmark[] | null;
  inferenceMs: number;
}

export interface PoseDetector {
  readonly delegate: Delegate;
  readonly mode: DetectorMode;
  /**
   * Runs the model on the video's current frame; resolves to null if the frame couldn't be read.
   * Callers keep one call in flight and drop frames that arrive meanwhile.
   */
  detect(video: HTMLVideoElement, timestamp: number): Promise<Detection | null>;
  close(): void;
}

export interface Backend {
  delegate: Delegate;
  worker: boolean;
}

export type WorkerRequest =
  | { type: "load"; delegate: Delegate }
  | { type: "detect"; frame: ImageBitmap; timestamp: number };

export type WorkerResponse =
  | { type: "loaded"; delegate: Delegate }
  | { type: "detected"; landmarks: Landmark[] | null; inferenceMs: number }
  | { type: "failed"; message: string };

// The model looks at a 256 px crop, so larger frames only cost copying time.
const MAX_FRAME_SIDE = 480;

/**
 * Phones run the model on the GPU, which is several times faster there than the CPU. Desktops use
 * the CPU: the lite model keeps up easily, and MediaPipe's GPU warm-up can stall integrated
 * graphics for many seconds. `?delegate=gpu|cpu` and `?pose=main` override this for testing.
 */
export function preferredBackend(): Backend {
  const params = new URLSearchParams(location.search);
  const forced = params.get("delegate")?.toUpperCase();
  const delegate = forced === "GPU" || forced === "CPU" ? forced : isMobile() ? "GPU" : "CPU";
  return { delegate, worker: params.get("pose") !== "main" };
}

function isMobile(): boolean {
  const hints = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  // iPadOS reports itself as a Mac, so touch support gives it away.
  const iPad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return hints?.mobile === true || iPad || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/**
 * Loads the pose model, off the main thread where the browser allows it. The worker keeps the UI
 * smooth because inference never blocks rendering; without one (or if it fails to start), the
 * model runs on the main thread instead.
 */
export async function createPoseDetector({ delegate, worker }: Backend): Promise<PoseDetector> {
  if (worker && supportsWorkerDetection()) {
    try {
      return await startWorker(delegate);
    } catch {
      // Fall through to the main thread.
    }
  }
  const { createMainThreadDetector } = await import("./landmarker");
  return createMainThreadDetector(delegate);
}

async function startWorker(preferred: Delegate): Promise<PoseDetector> {
  const worker = new Worker(new URL("./landmarker.worker.ts", import.meta.url), { type: "module" });
  // The worker answers in order, so replies are matched to requests first in, first out.
  const pending: ((response: WorkerResponse) => void)[] = [];
  const failAll = (message: string) => {
    for (const settle of pending.splice(0)) settle({ type: "failed", message });
  };

  const send = (request: WorkerRequest, transfer: Transferable[] = []) =>
    new Promise<WorkerResponse>((resolve) => {
      pending.push(resolve);
      worker.postMessage(request, transfer);
    });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => pending.shift()?.(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    failAll(event.message || "worker error");
  };

  const loaded = await send({ type: "load", delegate: preferred });
  if (loaded.type !== "loaded") {
    worker.terminate();
    throw new Error(loaded.type === "failed" ? loaded.message : "unexpected worker reply");
  }

  return {
    delegate: loaded.delegate,
    mode: "worker",
    async detect(video, timestamp) {
      const frame = await createImageBitmap(video, frameOptions(video)).catch(() => null);
      if (!frame) return null;
      const reply = await send({ type: "detect", frame, timestamp }, [frame]);
      if (reply.type !== "detected") {
        throw new Error(reply.type === "failed" ? reply.message : "unexpected worker reply");
      }
      return { landmarks: reply.landmarks, inferenceMs: reply.inferenceMs };
    },
    close() {
      worker.terminate();
      failAll("closed");
    },
  };
}

/** Shrinks a video frame for inference while keeping its aspect ratio. */
function frameOptions(video: HTMLVideoElement): ImageBitmapOptions {
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(video.videoWidth, video.videoHeight));
  return {
    resizeWidth: Math.round(video.videoWidth * scale),
    resizeHeight: Math.round(video.videoHeight * scale),
    resizeQuality: "low",
  };
}
