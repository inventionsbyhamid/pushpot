import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { Button, ButtonLink } from "../components/Button";
import { PageSpinner } from "../components/PageSpinner";
import { CheckInLayout } from "../features/checkin/CheckInLayout";
import { CheckInPanel } from "../features/checkin/CheckInPanel";
import { CheckInRecorded } from "../features/checkin/CheckInRecorded";
import { ReadyPanel } from "../features/checkin/ReadyPanel";
import { WorkoutSession } from "../features/workout/WorkoutSession";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { celebrate } from "../lib/celebrate";
import { describeError } from "../lib/errors";
import { parsePotId, periodName } from "../lib/pot";
import { potKeys, usePot } from "../lib/queries";
import type { RecordedWorkout, StartedWorkout } from "../lib/types";
import type { Telemetry, WorkoutResult } from "../pose/types";
import NotFound from "./NotFound";

type Stage =
  | { kind: "ready" }
  | { kind: "starting" }
  | { kind: "counting"; workout: StartedWorkout }
  | { kind: "submitting" }
  | { kind: "recorded"; workout: StartedWorkout; result: RecordedWorkout }
  | { kind: "rejected"; reason: string }
  | { kind: "unsent"; workout: StartedWorkout; telemetry: Telemetry; message: string }
  | { kind: "blocked"; message: string; retryable: boolean };

/** Client errors that resending the same telemetry won't fix. */
function isFinal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![401, 408, 429].includes(error.status)
  );
}

export default function PotWorkout() {
  const potId = parsePotId(useParams().id);
  if (potId === null) return <NotFound message="That pot link doesn't look right." />;
  return <WorkoutFlow potId={potId} />;
}

function WorkoutFlow({ potId }: { potId: number }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuth();
  const { openConnectModal } = useConnectModal();
  const pot = usePot(potId).data?.pot;
  const [stage, setStage] = useState<Stage>({ kind: "ready" });

  const start = async () => {
    setStage({ kind: "starting" });
    try {
      const workout = await api.post<StartedWorkout>("/api/workouts", { pot_id: potId });
      setStage({ kind: "counting", workout });
    } catch (error) {
      setStage({ kind: "blocked", message: describeError(error), retryable: !isFinal(error) });
    }
  };

  // Stable so the camera session isn't re-rendered with new handlers.
  const submit = useCallback(
    async (workout: StartedWorkout, telemetry: Telemetry) => {
      setStage({ kind: "submitting" });
      try {
        const result = await api.post<RecordedWorkout>(
          `/api/workouts/${workout.workout_id}/complete`,
          { telemetry },
        );
        setStage({ kind: "recorded", workout, result });
        celebrate();
        void queryClient.invalidateQueries({ queryKey: potKeys.detail(potId) });
      } catch (error) {
        if (error instanceof ApiError && error.status === 422) {
          setStage({ kind: "rejected", reason: error.message });
        } else if (isFinal(error)) {
          setStage({ kind: "blocked", message: error.message, retryable: false });
        } else {
          setStage({ kind: "unsent", workout, telemetry, message: describeError(error) });
        }
      }
    },
    [potId, queryClient],
  );
  const exit = useCallback(() => navigate(`/p/${potId}`), [navigate, potId]);

  if (stage.kind === "counting") {
    return <Counting workout={stage.workout} onSubmit={submit} onExit={exit} />;
  }

  let content: ReactNode;
  switch (stage.kind) {
    case "ready":
    case "starting":
      if (auth.status === "loading") {
        content = <PageSpinner />;
      } else if (auth.status !== "authenticated") {
        content = (
          <CheckInPanel
            title="Sign in to check in"
            body="Sign a message with your wallet so the server knows these reps are yours. It's free and sends no transaction."
          >
            <Button className="min-h-14 w-full text-2xl" onClick={() => openConnectModal?.()}>
              Sign in
            </Button>
          </CheckInPanel>
        );
      } else {
        content = (
          <ReadyPanel pot={pot} starting={stage.kind === "starting"} onStart={() => void start()} />
        );
      }
      break;
    case "submitting":
      content = <PageSpinner message="Checking your set and recording it on Arc" />;
      break;
    case "recorded":
      content = (
        <CheckInRecorded
          potId={potId}
          result={stage.result}
          reps={stage.workout.reps_target}
          periodLabel={
            pot ? `${periodName(pot).toLowerCase()} ${stage.workout.period + 1}` : "today"
          }
        />
      );
      break;
    case "rejected":
      content = (
        <CheckInPanel title="That set didn't count" body={stage.reason} tone="error">
          <Button className="min-h-14 w-full text-2xl" onClick={() => void start()}>
            Try again
          </Button>
          <BackToPot potId={potId} />
        </CheckInPanel>
      );
      break;
    case "unsent": {
      const { workout, telemetry } = stage;
      const signedIn = auth.status === "authenticated";
      content = (
        <CheckInPanel
          title="Your set wasn't sent"
          body={`${stage.message} Keep this page open: retrying sends the same set again.`}
          tone="error"
        >
          <Button
            className="min-h-14 w-full text-2xl"
            onClick={() => (signedIn ? void submit(workout, telemetry) : openConnectModal?.())}
          >
            {signedIn ? "Retry" : "Sign in to retry"}
          </Button>
        </CheckInPanel>
      );
      break;
    }
    case "blocked":
      content = (
        <CheckInPanel title="Can't check in right now" body={stage.message} tone="error">
          {stage.retryable && (
            <Button className="min-h-14 w-full text-2xl" onClick={() => void start()}>
              Try again
            </Button>
          )}
          <BackToPot potId={potId} primary={!stage.retryable} />
        </CheckInPanel>
      );
      break;
  }

  return <CheckInLayout potId={potId}>{content}</CheckInLayout>;
}

interface CountingProps {
  workout: StartedWorkout;
  onSubmit: (workout: StartedWorkout, telemetry: Telemetry) => Promise<void>;
  onExit: () => void;
}

function Counting({ workout, onSubmit, onExit }: CountingProps) {
  const complete = useCallback(
    (result: WorkoutResult) => void onSubmit(workout, result.telemetry),
    [onSubmit, workout],
  );
  return (
    <WorkoutSession
      target={workout.reps_target}
      workoutId={workout.workout_id}
      onComplete={complete}
      onExit={onExit}
    />
  );
}

function BackToPot({ potId, primary = false }: { potId: number; primary?: boolean }) {
  return (
    <ButtonLink
      to={`/p/${potId}`}
      variant={primary ? "primary" : "secondary"}
      className="min-h-14 w-full text-2xl"
    >
      Back to pot
    </ButtonLink>
  );
}
