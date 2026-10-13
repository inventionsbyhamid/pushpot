import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { createPoseDetector, type Delegate, type PoseDetector } from "../../pose/landmarker";
import type { Landmark } from "../../pose/landmarks";

export type DetectorStatus = "loading" | "ready" | "paused" | "error";

export interface DetectedFrame {
  /** Wall time of the frame in milliseconds. */
  now: number;
  landmarks: Landmark[] | null;
  video: HTMLVideoElement;
  delegate: Delegate;
}

/**
 * Loads the pose model as soon as it mounts and, while `running`, runs it on every new video
 * frame. The model is dropped while the page is hidden, because iOS may discard its WebGL
 * context in the background, and reloaded when the page is visible again.
 */
export function usePoseLoop(
  videoRef: RefObject<HTMLVideoElement | null>,
  running: boolean,
  onFrame: (frame: DetectedFrame) => void,
) {
  const [status, setStatus] = useState<DetectorStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  const detectorRef = useRef<PoseDetector | null>(null);
  const preferredRef = useRef<Delegate>("GPU");
  const handleFrame = useEffectEvent(onFrame);

  useEffect(() => {
    let generation = 0;

    const unload = () => {
      generation += 1;
      detectorRef.current?.close();
      detectorRef.current = null;
    };

    const load = async () => {
      unload();
      const current = generation;
      setStatus("loading");
      try {
        const detector = await createPoseDetector(preferredRef.current);
        if (current !== generation) {
          detector.close();
          return;
        }
        detectorRef.current = detector;
        setStatus("ready");
      } catch {
        if (current === generation) setStatus("error");
      }
    };

    const onVisibility = () => {
      if (!document.hidden) {
        void load();
        return;
      }
      unload();
      setStatus("paused");
    };

    document.addEventListener("visibilitychange", onVisibility);
    if (document.hidden) setStatus("paused");
    else void load();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      unload();
    };
  }, [attempt]);

  useEffect(() => {
    const video = videoRef.current;
    if (!running || status !== "ready" || !video) return;

    // Without requestVideoFrameCallback, poll animation frames and skip those with no new video frame.
    const frameCallbacks = typeof video.requestVideoFrameCallback === "function";
    let handle = 0;
    let stopped = false;
    let lastMediaTime = -1;

    const process = (now: number) => {
      const detector = detectorRef.current;
      if (!detector || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
      let landmarks: Landmark[] | null;
      try {
        landmarks = detector.detect(video, now);
      } catch {
        stopped = true;
        if (detector.delegate === "GPU") {
          preferredRef.current = "CPU";
          setAttempt((n) => n + 1);
        } else {
          setStatus("error");
        }
        return;
      }
      handleFrame({ now, landmarks, video, delegate: detector.delegate });
    };

    const schedule = () => {
      if (stopped) return;
      if (frameCallbacks) {
        handle = video.requestVideoFrameCallback((now) => {
          process(now);
          schedule();
        });
        return;
      }
      handle = requestAnimationFrame((now) => {
        if (video.currentTime !== lastMediaTime) {
          lastMediaTime = video.currentTime;
          process(now);
        }
        schedule();
      });
    };

    schedule();
    return () => {
      stopped = true;
      if (frameCallbacks) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [running, status, videoRef]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, retry };
}
