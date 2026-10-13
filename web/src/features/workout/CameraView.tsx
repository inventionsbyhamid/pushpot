import type { RefObject } from "react";

interface CameraViewProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayRef: RefObject<HTMLCanvasElement | null>;
  /** Mirror the front camera so it reads like a mirror; landmarks stay in camera space. */
  mirrored: boolean;
}

export function CameraView({ videoRef, overlayRef, mirrored }: CameraViewProps) {
  const flip = mirrored ? "-scale-x-100" : "";
  return (
    <div aria-hidden className="absolute inset-0 bg-ink">
      {/* Never display:none the live video: iOS stops handing its frames to the GPU. */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className={`absolute inset-0 size-full object-contain ${flip}`}
      />
      <canvas ref={overlayRef} className={`pointer-events-none absolute inset-0 size-full object-contain ${flip}`} />
    </div>
  );
}
