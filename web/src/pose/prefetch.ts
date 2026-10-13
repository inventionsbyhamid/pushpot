import { runtimeFiles, supportsWorkerDetection } from "./assets";

let started = false;

/**
 * Warms the HTTP cache with the pose runtime and model (about 17 MB) while the browser is idle,
 * so a workout started later doesn't wait on the download. Skipped when Data Saver is on.
 */
export function prefetchPoseRuntime(): void {
  if (started) return;
  started = true;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return;

  const whenIdle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 2000));
  whenIdle(() => {
    for (const url of runtimeFiles(supportsWorkerDetection())) {
      fetch(url, { priority: "low" })
        .then((res) => res.body?.pipeTo(new WritableStream()))
        .catch(() => undefined);
    }
  });
}
