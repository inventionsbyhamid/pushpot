import { Button } from "../../components/Button";
import { useNow } from "../../hooks/useNow";
import { formatDuration } from "../../lib/format";
import { potClock } from "../../lib/pot";
import type { Pot } from "../../lib/types";
import { CheckInPanel } from "./CheckInPanel";

interface ReadyPanelProps {
  pot: Pot | undefined;
  starting: boolean;
  onStart: () => void;
}

export function ReadyPanel({ pot, starting, onStart }: ReadyPanelProps) {
  const now = useNow();
  const deadline = pot ? potClock(pot, now).periodEndsAt : null;

  return (
    <CheckInPanel
      title={pot ? `${pot.reps_per_period} pushups` : "Today's set"}
      context={pot?.title}
      body="Put your phone on the floor about two meters away and sideways to the camera, with your whole body in frame. Reps are counted on this phone and no video leaves it."
    >
      {deadline !== null && (
        <p className="text-center text-sm text-amber">
          Deadline in {formatDuration((deadline - now) / 1000)}
        </p>
      )}
      <Button className="min-h-14 w-full text-2xl" disabled={starting} onClick={onStart}>
        {starting ? "Starting" : "Start camera"}
      </Button>
    </CheckInPanel>
  );
}
