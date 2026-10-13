import { FilesetResolver } from "@mediapipe/tasks-vision";
import { WASM_PATH } from "./assets";
import type { WorkerRequest, WorkerResponse } from "./detector";
import { loadLandmarker, type Landmarker } from "./landmarker";

let landmarker: Landmarker | null = null;

const reply = (response: WorkerResponse) => postMessage(response);

async function load({ delegate }: Extract<WorkerRequest, { type: "load" }>): Promise<void> {
  try {
    // An absolute URL keeps Vite's dev server from rewriting MediaPipe's import() of the ES module build.
    const wasm = await FilesetResolver.forVisionTasks(new URL(WASM_PATH, location.origin).href, true);
    landmarker = await loadLandmarker(wasm, delegate, () => new OffscreenCanvas(1, 1));
    reply({ type: "loaded", delegate: landmarker.delegate });
  } catch (error) {
    reply({ type: "failed", message: String(error) });
  }
}

function detect({ frame, timestamp }: Extract<WorkerRequest, { type: "detect" }>): void {
  try {
    if (!landmarker) throw new Error("model not loaded");
    const start = performance.now();
    const landmarks = landmarker.detect(frame, timestamp);
    reply({ type: "detected", landmarks, inferenceMs: performance.now() - start });
  } catch (error) {
    reply({ type: "failed", message: String(error) });
  } finally {
    frame.close();
  }
}

onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "load") void load(event.data);
  else detect(event.data);
};
