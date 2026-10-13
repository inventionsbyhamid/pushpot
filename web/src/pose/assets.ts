// Kept free of MediaPipe imports so pages can prefetch without pulling in the pose runtime.

export const POSE_MODEL = "pose_landmarker_lite";
export const WASM_PATH = "/mediapipe/wasm";
export const MODEL_PATH = `/mediapipe/${POSE_MODEL}.task`;

let workerSupport: boolean | undefined;

/**
 * Whether pose detection can run in a worker: it needs WebGL2 on an OffscreenCanvas and a way to
 * hand video frames over. Probed on the main thread, which shares the worker's capabilities.
 */
export function supportsWorkerDetection(): boolean {
  workerSupport ??= probeWorkerSupport();
  return workerSupport;
}

function probeWorkerSupport(): boolean {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return false;
  if (typeof createImageBitmap !== "function") return false;
  try {
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/** The runtime files MediaPipe will request: the worker loads the ES module build. */
export function runtimeFiles(inWorker: boolean): string[] {
  const name = `${WASM_PATH}/vision_wasm${inWorker ? "_module" : ""}_internal`;
  return [`${name}.js`, `${name}.wasm`, MODEL_PATH];
}
