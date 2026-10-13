import { Athlete, type AngleReadout, type Tone } from "./Athlete";
import { solvePose, type PoseParams } from "./kinematics";

export type FigureKind = "plank" | "bottom" | "sag" | "pike" | "half" | "headDrop";

interface FigureSpec {
  pose: PoseParams;
  label: string;
  arm: Tone;
  body: Tone;
  neck?: Tone;
  readout?: AngleReadout["joint"];
}

// Faults are drawn in flare; the parts that aren't the point fade to mute.
const FIGURES: Record<FigureKind, FigureSpec> = {
  plank: {
    pose: { elbow: 172 },
    label: "Side view of a good plank: arms straight, body in one straight line from head to heels.",
    arm: "volt",
    body: "volt",
  },
  bottom: {
    pose: { elbow: 90 },
    label: "Side view of the bottom of a good rep: elbows bent to about 90 degrees, body straight.",
    arm: "volt",
    body: "volt",
    readout: "elbow",
  },
  sag: {
    pose: { elbow: 168, hipBend: 45 },
    label: "Side view of sagging hips: they drop below the line from shoulders to heels.",
    arm: "mute",
    body: "flare",
    readout: "hip",
  },
  pike: {
    pose: { elbow: 168, hipBend: -50 },
    label: "Side view of piked hips: they stick up above the line from shoulders to heels.",
    arm: "mute",
    body: "flare",
    readout: "hip",
  },
  half: {
    pose: { elbow: 125 },
    label: "Side view of a half rep: the elbows only bend to about 125 degrees.",
    arm: "flare",
    body: "mute",
    readout: "elbow",
  },
  headDrop: {
    pose: { elbow: 165, headDrop: 60 },
    label: "Side view of a dropped head hanging down towards the floor.",
    arm: "mute",
    body: "mute",
    neck: "flare",
  },
};

/** A still side view of one form point, drawn like the camera overlay. */
export function FormFigure({ kind, className = "" }: { kind: FigureKind; className?: string }) {
  const { pose, label, arm, body, neck, readout } = FIGURES[kind];
  const value = readout === "hip" ? 180 - Math.abs(pose.hipBend ?? 0) : pose.elbow;
  const tone = readout === "hip" ? body : arm;

  return (
    <svg viewBox="-14 -92 186 100" role="img" aria-label={label} className={`rounded-lg bg-panel ${className}`}>
      <line x1={-14} x2={172} className="stroke-line" strokeWidth={1.2} />
      <Athlete
        pose={solvePose(pose)}
        arm={arm}
        body={body}
        neck={neck}
        readouts={readout ? [{ joint: readout, value, tone }] : []}
        unit={2.6}
        labelSize={15}
      />
    </svg>
  );
}
