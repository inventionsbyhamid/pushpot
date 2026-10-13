import { useEffect, useState, type RefObject } from "react";
import { themeColor } from "./feedback";
import { createPoseOverlay, type OverlayView, type PoseOverlay } from "./overlay";

// Past 2x the extra pixels cost GPU time that inference needs, for lines that look the same.
const MAX_DPR = 2;

/**
 * Draws the pose overlay at display rate while `active`. The canvas is laid over exactly the
 * part of its container the video fills (`object-fit: contain`), at the device pixel ratio so
 * lines stay crisp. Feed it detections with `push`.
 */
export function usePoseOverlay(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
  mirrored: boolean,
  active: boolean,
): PoseOverlay {
  const [overlay] = useState(createPoseOverlay);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const container = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!active || !canvas || !video || !container || !ctx) return;

    const view: OverlayView = {
      width: 0,
      height: 0,
      dpr: 1,
      mirrored,
      colors: {
        active: themeColor("volt", "#ccff2e"),
        inactive: themeColor("mute", "#8f9891"),
        bone: themeColor("chalk", "#f1efe6"),
        ink: themeColor("ink", "#0c0f0d"),
      },
    };
    const layout = () => {
      const { clientWidth, clientHeight } = container;
      const scale = video.videoWidth ? Math.min(clientWidth / video.videoWidth, clientHeight / video.videoHeight) : 0;
      view.width = video.videoWidth * scale;
      view.height = video.videoHeight * scale;
      view.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.style.left = `${(clientWidth - view.width) / 2}px`;
      canvas.style.top = `${(clientHeight - view.height) / 2}px`;
      canvas.style.width = `${view.width}px`;
      canvas.style.height = `${view.height}px`;
      // Assigning the size clears the canvas, even when it is unchanged.
      const width = Math.round(view.width * view.dpr);
      const height = Math.round(view.height * view.dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
    };
    const observer = new ResizeObserver(layout);
    observer.observe(container);
    video.addEventListener("resize", layout);
    layout();

    let frame = 0;
    const videoFrames = typeof video.requestVideoFrameCallback === "function";
    const render = (now: number) => {
      frame = videoFrames ? video.requestVideoFrameCallback(render) : requestAnimationFrame(render);
      overlay.draw(ctx, view, now);
    };
    frame = videoFrames ? video.requestVideoFrameCallback(render) : requestAnimationFrame(render);

    return () => {
      if (videoFrames) video.cancelVideoFrameCallback(frame);
      else cancelAnimationFrame(frame);
      observer.disconnect();
      video.removeEventListener("resize", layout);
      overlay.reset();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, mirrored, canvasRef, videoRef, overlay]);

  return overlay;
}
