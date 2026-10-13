import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";
import { Button } from "../../components/Button";
import { POSE_MODEL } from "../../pose/assets";
import type { Delegate } from "../../pose/detector";
import type { Cue, Phase } from "../../pose/repCounter";
import type { SetupChecks } from "../../pose/setup";
import { createWorkoutTracker } from "../../pose/tracker";
import type { WorkoutResult } from "../../pose/types";
import { CameraView } from "./CameraView";
import { celebrate, createBeeper, createWakeLock, CUE_TEXT, isFault, pulse } from "./feedback";
import { DoneOverlay, ErrorPanel, IconButton, PerfHud, Scoreboard, StatusBanner } from "./Hud";
import { CloseIcon, RotateIcon, SwitchCameraIcon } from "./icons";
import { SessionIntro } from "./SessionIntro";
import { SetupGuide } from "./SetupGuide";
import { useCamera, type CameraError } from "./useCamera";
import { useMediaQuery } from "./useMediaQuery";
import { usePoseLoop, type DetectedFrame } from "./usePoseLoop";
import { usePoseOverlay } from "./usePoseOverlay";

export interface WorkoutSessionProps {
  /** Reps to finish; omit for practice, where the user taps Finish. */
  target?: number;
  /** Recorded as `telemetry.workout_id`; defaults to "practice". */
  workoutId?: string;
  onComplete: (result: WorkoutResult) => void;
  onExit?: () => void;
}

type Stage = "intro" | "live" | "done";

interface LiveState {
  count: number;
  phase: Phase;
  cue: Cue | null;
  checks: SetupChecks;
}

const INITIAL_LIVE: LiveState = {
  count: 0,
  phase: "setup",
  cue: null,
  checks: { inFrame: false, sideOn: false, plank: false },
};

const CELEBRATION_MS = 1800;

const CAMERA_ERRORS: Record<CameraError, string> = {
  insecure: "The camera needs a secure (HTTPS) connection.",
  unsupported: "This browser can't use the camera. Try Safari or Chrome.",
  denied: "Camera access is blocked. Allow it in your browser's site settings, then retry.",
  not_found: "No camera was found on this device.",
  in_use: "The camera is busy in another app. Close it, then retry.",
  failed: "The camera couldn't start.",
};

function sameLive(a: LiveState, b: LiveState): boolean {
  return (
    a.count === b.count &&
    a.phase === b.phase &&
    a.cue === b.cue &&
    a.checks.inFrame === b.checks.inFrame &&
    a.checks.sideOn === b.checks.sideOn &&
    a.checks.plank === b.checks.plank
  );
}

/**
 * Full-screen camera workout: setup tips, live rep counting with on-device pose detection, and a
 * result carrying telemetry for the caller to submit. Never talks to the backend itself.
 */
export function WorkoutSession({ target, workoutId, onComplete, onExit }: WorkoutSessionProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [tracker] = useState(createWorkoutTracker);
  const [beeper] = useState(createBeeper);
  const [wakeLock] = useState(createWakeLock);
  const [stage, setStage] = useState<Stage>("intro");
  const [live, setLive] = useState(INITIAL_LIVE);
  const liveRef = useRef(INITIAL_LIVE);
  const sourceRef = useRef<{ delegate: Delegate; w: number; h: number }>({ delegate: "GPU", w: 0, h: 0 });
  const resultRef = useRef<WorkoutResult | null>(null);
  const camera = useCamera(videoRef);
  const { stop: stopCamera } = camera;
  const portrait = useMediaQuery("(orientation: portrait)");
  const [debug] = useState(() => new URLSearchParams(window.location.search).has("debug"));
  const overlay = usePoseOverlay(overlayRef, videoRef, camera.facing === "user", stage === "live");

  const finish = () => {
    if (resultRef.current) return;
    const { delegate, w, h } = sourceRef.current;
    resultRef.current = tracker.result({
      workout_id: workoutId ?? "practice",
      model: POSE_MODEL,
      delegate,
      video: { w, h },
    });
    setStage("done");
  };

  const onFrame = ({ now, landmarks, video, delegate }: DetectedFrame) => {
    if (resultRef.current) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    sourceRef.current = { delegate, w, h };
    const update = tracker.push(now, landmarks ?? [], w, h);

    overlay.push(
      { landmarks, time: now, width: w, height: h, side: update.side, valid: update.valid, elbow: update.elbow },
      performance.now(),
    );

    const reached = target !== undefined && update.count >= target;
    if (update.count > liveRef.current.count) {
      beeper.beep(reached);
      pulse();
    }
    const next: LiveState = { count: update.count, phase: update.phase, cue: update.cue, checks: update.checks };
    if (!sameLive(next, liveRef.current)) {
      liveRef.current = next;
      setLive(next);
    }
    if (reached) finish();
  };

  const pose = usePoseLoop(videoRef, stage === "live" && camera.status === "live", onFrame);

  const begin = () => {
    // Both need the user gesture on iOS.
    beeper.unlock();
    wakeLock.acquire();
    setStage("live");
    void camera.start("user");
  };

  const notifyComplete = useEffectEvent((result: WorkoutResult) => onComplete(result));

  useEffect(() => {
    const result = resultRef.current;
    if (stage !== "done" || !result) return;
    stopCamera();
    wakeLock.release();
    const celebrating = target !== undefined;
    if (celebrating) celebrate();
    const timer = setTimeout(() => notifyComplete(result), celebrating ? CELEBRATION_MS : 0);
    return () => clearTimeout(timer);
  }, [stage, target, stopCamera, wakeLock]);

  useEffect(
    () => () => {
      beeper.close();
      wakeLock.release();
    },
    [beeper, wakeLock],
  );

  const loading =
    camera.status === "starting" ? "Starting camera" : pose.status === "loading" ? "Loading pose model" : null;
  const showGuide = !loading && live.phase === "setup";
  const cue = live.phase === "lost" ? "move_into_frame" : live.phase === "setup" ? null : live.cue;

  return (
    <div className="fixed inset-0 z-40 overflow-hidden bg-ink text-chalk select-none">
      <CameraView videoRef={videoRef} overlayRef={overlayRef} mirrored={camera.facing === "user"} />

      {stage === "intro" ? (
        <SessionIntro target={target} onStart={begin} onExit={onExit} />
      ) : (
        <div className="absolute inset-0 flex flex-col justify-between gap-3 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))]">
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <Scoreboard count={live.count} target={target} />
              <div className="flex gap-2">
                <IconButton
                  label="Switch camera"
                  onClick={() => void camera.start(camera.facing === "user" ? "environment" : "user")}
                >
                  <SwitchCameraIcon />
                </IconButton>
                {onExit && (
                  <IconButton label="Exit workout" onClick={onExit}>
                    <CloseIcon />
                  </IconButton>
                )}
              </div>
            </div>
            {portrait && (
              <p className="flex items-center gap-2 self-center rounded-full bg-ink/85 px-4 py-2 text-sm text-mute">
                <RotateIcon />
                Turn your phone sideways for a wider view
              </p>
            )}
          </div>

          <div className="flex flex-col items-center gap-3">
            <div aria-live="polite" className="flex w-full max-w-md justify-center">
              {loading ? (
                <StatusBanner tone="pending" busy>
                  {loading}
                </StatusBanner>
              ) : showGuide ? (
                <SetupGuide checks={live.checks} />
              ) : cue ? (
                <StatusBanner tone={isFault(cue) ? "fault" : "pending"}>{CUE_TEXT[cue]}</StatusBanner>
              ) : null}
            </div>
            <div className="flex w-full items-end justify-between gap-3">
              <p className="text-xs text-mute">Counted on your phone · no video leaves it</p>
              {target === undefined && stage === "live" && (
                <Button variant="secondary" onClick={finish} className="shrink-0">
                  Finish
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {camera.status === "error" && camera.error && (
        <ErrorPanel
          title="Camera unavailable"
          message={CAMERA_ERRORS[camera.error]}
          onRetry={() => void camera.start(camera.facing)}
          onExit={onExit}
        />
      )}
      {stage === "live" && pose.status === "error" && (
        <ErrorPanel
          title="Pose model failed"
          message="The pose model couldn't load. Check your connection, then retry."
          onRetry={pose.retry}
          onExit={onExit}
        />
      )}
      {debug && stage === "live" && <PerfHud stats={pose.stats} backend={pose.backend} videoRef={videoRef} />}
      {stage === "done" && target !== undefined && <DoneOverlay count={live.count} />}
    </div>
  );
}
