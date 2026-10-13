import { useEffect } from "react";
import { prefetchPoseRuntime } from "../../pose/prefetch";

/** Starts downloading the pose runtime in the background so a workout opens without waiting. */
export function usePosePrefetch(): void {
  useEffect(prefetchPoseRuntime, []);
}
