import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import {
  createPoseDetector,
  preferredBackend,
  type Backend,
  type Delegate,
  type DetectorMode,
  type PoseDetector,
} from "../../pose/detector";
import type { Landmark } from "../../pose/landmarks";
import { PerfStats } from "./perfStats";

export type DetectorStatus = "loading" | "ready" | "paused" | "error";

export interface DetectedFrame {
  /** Wall time of the frame in milliseconds. */
  now: number;
  landmarks: Landmark[] | null;
  video: HTMLVideoElement;
  delegate: Delegate;
}

export interface PoseBackend {
  delegate: Delegate;
  mode: DetectorMode;
}

/**
 * Loads the pose model as soon as it mounts and, while `running`, runs it on the newest video
 * frame whenever the previous detection has finished. The model is dropped while the page is
 * hidden, because iOS may discard its WebGL context in the background, and reloaded when the page
 * is visible again.
 */
export function usePoseLoop(
  videoRef: RefObject<HTMLVideoElement | null>,
  running: boolean,
  onFrame: (frame: DetectedFrame) => void,
) {
  const [status, setStatus] = useState<DetectorStatus>("loading");
  const [backend, setBackend] = useState<PoseBackend | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [stats] = useState(() => new PerfStats());
  const detectorRef = useRef<PoseDetector | null>(null);
  const preferredRef = useRef<Backend>(preferredBackend());
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
        setBackend({ delegate: detector.delegate, mode: detector.mode });
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
    const detector = detectorRef.current;
    if (!running || status !== "ready" || !video || !detector) return;

    // Without requestVideoFrameCallback, poll animation frames and skip those with no new video frame.
    const frameCallbacks = typeof video.requestVideoFrameCallback === "function";
    let handle = 0;
    let stopped = false;
    let busy = false;
    let waiting: number | null = null;
    let lastMediaTime = -1;

    // The detector may be closed (page hidden, retry) before this effect is cleaned up.
    const active = () => !stopped && detectorRef.current === detector;

    const fail = () => {
      stopped = true;
      if (detector.delegate === "CPU" && detector.mode === "main") {
        setStatus("error");
        return;
      }
      // A GPU that fails mid-session gets the CPU; a worker that still fails gets the main thread.
      preferredRef.current = { delegate: "CPU", worker: detector.mode === "worker" && detector.delegate === "GPU" };
      setAttempt((n) => n + 1);
    };

    const process = (now: number) => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
      busy = true;
      detector.detect(video, now).then(
        (detection) => {
          busy = false;
          if (!active()) return;
          if (detection) {
            stats.record(performance.now(), detection.inferenceMs);
            handleFrame({ now, landmarks: detection.landmarks, video, delegate: detector.delegate });
          }
          // Frames that arrived during inference were dropped; catch up on the newest one now
          // rather than idling until the next frame.
          if (waiting !== null) {
            const next = waiting;
            waiting = null;
            process(next);
          }
        },
        () => {
          busy = false;
          if (active()) fail();
        },
      );
    };

    const onVideoFrame = (now: number) => {
      if (busy) waiting = now;
      else process(now);
    };

    const schedule = () => {
      if (stopped) return;
      if (frameCallbacks) {
        handle = video.requestVideoFrameCallback((now) => {
          onVideoFrame(now);
          schedule();
        });
        return;
      }
      handle = requestAnimationFrame((now) => {
        if (video.currentTime !== lastMediaTime) {
          lastMediaTime = video.currentTime;
          onVideoFrame(now);
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
  }, [running, status, videoRef, stats]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { status, backend, stats, retry };
}
