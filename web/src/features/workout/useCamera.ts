import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type Facing = "user" | "environment";
export type CameraStatus = "idle" | "starting" | "live" | "error";
export type CameraError = "insecure" | "unsupported" | "denied" | "not_found" | "in_use" | "failed";

function toCameraError(error: unknown): CameraError {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "not_found";
    case "NotReadableError":
    case "AbortError":
      return "in_use";
    default:
      return "failed";
  }
}

const UPRIGHT = "(orientation: portrait)";

/** Chrome's control over cropping and scaling to the requested size; not in the DOM types yet. */
type VideoConstraints = MediaTrackConstraints & { resizeMode?: ConstrainDOMString };

/**
 * Asks for frames shaped like the screen as the phone is held. A landscape request on an upright
 * phone makes browsers crop a strip out of the middle of the view, cutting off head and hands;
 * `resizeMode` keeps Chrome from cropping to fit whatever is asked.
 */
function videoConstraints(facing: Facing): VideoConstraints {
  const upright = window.matchMedia(UPRIGHT).matches;
  return {
    facingMode: facing,
    width: { ideal: upright ? 480 : 640 },
    height: { ideal: upright ? 640 : 480 },
    frameRate: { ideal: 30, max: 30 },
    resizeMode: { ideal: "none" },
  };
}

export function useCamera(videoRef: RefObject<HTMLVideoElement | null>) {
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<CameraError | null>(null);
  const [facing, setFacing] = useState<Facing>("user");
  const streamRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<Facing>("user");
  const requestRef = useRef(0);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [videoRef]);

  const stop = useCallback(() => {
    requestRef.current += 1;
    releaseStream();
    setStatus("idle");
  }, [releaseStream]);

  const start = useCallback(
    async (nextFacing: Facing) => {
      const fail = (reason: CameraError) => {
        setError(reason);
        setStatus("error");
      };
      if (!window.isSecureContext) return fail("insecure");
      if (!navigator.mediaDevices?.getUserMedia) return fail("unsupported");

      const request = ++requestRef.current;
      // Phones can't open two cameras at once, so let go of the current one first.
      releaseStream();
      setStatus("starting");
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints(nextFacing) });
        const video = videoRef.current;
        if (request !== requestRef.current || !video) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        facingRef.current = nextFacing;
        setFacing(nextFacing);
        setStatus("live");
      } catch (err) {
        if (request === requestRef.current) fail(toCameraError(err));
      }
    },
    [releaseStream, videoRef],
  );

  // iOS can end the track or pause the video while the app is in the background.
  useEffect(() => {
    const onVisibility = () => {
      const stream = streamRef.current;
      if (document.hidden || !stream) return;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState === "ended") void start(facingRef.current);
      else void videoRef.current?.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [start, videoRef]);

  // A stream keeps the shape it started with, so turning the phone needs a fresh one.
  useEffect(() => {
    const query = window.matchMedia(UPRIGHT);
    const onRotate = () => {
      if (streamRef.current) void start(facingRef.current);
    };
    query.addEventListener("change", onRotate);
    return () => query.removeEventListener("change", onRotate);
  }, [start]);

  useEffect(() => stop, [stop]);

  return { status, error, facing, start, stop };
}
