import { HEAD_RADIUS, type Skeleton, type Vec } from "./kinematics";

export type Tone = "volt" | "mute" | "flare";

const STROKE: Record<Tone, string> = { volt: "stroke-volt", mute: "stroke-mute", flare: "stroke-flare" };
const FILL: Record<Tone, string> = { volt: "fill-volt", mute: "fill-mute", flare: "fill-flare" };
const LOUDNESS: Tone[] = ["mute", "volt", "flare"];
const loudest = (...tones: Tone[]) =>
  tones.reduce((a, b) => (LOUDNESS.indexOf(b) > LOUDNESS.indexOf(a) ? b : a));

// The figure's y grows up from the floor; SVG's grows down.
const toScreen = (v: Vec): Vec => ({ x: v.x, y: -v.y });
const points = (...joints: Vec[]) => joints.map((v) => `${v.x},${-v.y}`).join(" ");

export interface AngleReadout {
  joint: "elbow" | "hip";
  value: number;
  tone: Tone;
}

interface AthleteProps {
  pose: Skeleton;
  /** Overlay colours for the arm and the body line, the two things the counter measures. */
  arm: Tone;
  body: Tone;
  /** Highlights the neck, which the counter ignores; it's drawn as a quiet bone otherwise. */
  neck?: Tone;
  readouts?: AngleReadout[];
  /** Overlay line weight in figure centimetres; small figures need bolder lines. */
  unit?: number;
  labelSize?: number;
}

/**
 * A side-view athlete with the camera overlay drawn the way the workout screen draws it: every
 * bone quiet, the measured arm and body line bold over a soft glow.
 */
export function Athlete({ pose, arm, body, neck, readouts = [], unit = 1.6, labelSize = 7 }: AthleteProps) {
  const { toe, ankle, knee, hip, shoulder, elbow, wrist, fingers, head } = pose;
  const regions = [
    { tone: arm, joints: [shoulder, elbow, wrist] },
    { tone: body, joints: [shoulder, hip, knee, ankle] },
    ...(neck ? [{ tone: neck, joints: [shoulder, head] }] : []),
  ];
  const dots: [Vec, Tone][] = [
    [shoulder, loudest(arm, body)],
    [elbow, arm],
    [wrist, arm],
    [hip, body],
    [knee, body],
    [ankle, body],
  ];

  return (
    <g strokeLinecap="round" strokeLinejoin="round" fill="none">
      <g className="stroke-chalk opacity-20">
        <polyline points={points(toe, ankle)} strokeWidth={5} />
        <polyline points={points(ankle, knee)} strokeWidth={7.5} />
        <polyline points={points(knee, hip)} strokeWidth={10} />
        <polyline points={points(hip, shoulder)} strokeWidth={14} />
        <polyline points={points(shoulder, head)} strokeWidth={6} />
        <polyline points={points(shoulder, elbow)} strokeWidth={7} />
        <polyline points={points(elbow, wrist, fingers)} strokeWidth={5.5} />
        <circle cx={head.x} cy={-head.y} r={HEAD_RADIUS} className="fill-chalk" stroke="none" />
      </g>

      <polyline
        points={points(toe, ankle, knee, hip, shoulder, elbow, wrist, fingers)}
        className="stroke-chalk opacity-60"
        strokeWidth={unit * 0.55}
      />
      <polyline points={points(shoulder, head)} className="stroke-chalk opacity-60" strokeWidth={unit * 0.55} />

      {regions.map(({ tone, joints }, i) => (
        <g key={i} className={`${STROKE[tone]} transition-colors duration-300`}>
          <polyline points={points(...joints)} strokeWidth={unit * 2.6} opacity={0.22} />
          <polyline points={points(...joints)} strokeWidth={unit * 1.1} />
        </g>
      ))}

      {[toe, fingers, head].map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={-p.y}
          r={unit * 0.75}
          className={neck && p === head ? `${FILL[neck]} stroke-ink` : "fill-chalk/60 stroke-ink"}
          strokeWidth={unit * 0.35}
        />
      ))}
      {dots.map(([p, tone], i) => (
        <circle
          key={i}
          cx={p.x}
          cy={-p.y}
          r={unit * 1.25}
          className={`${FILL[tone]} stroke-ink transition-colors duration-300`}
          strokeWidth={unit * 0.5}
        />
      ))}

      {readouts.map(({ joint, value, tone }) => (
        <AngleTag
          key={joint}
          a={shoulder}
          // The elbow's reading sits behind the arm, the hip's inside the bend, clear of the floor.
          {...(joint === "elbow"
            ? { vertex: elbow, c: wrist, side: "outside" }
            : { vertex: hip, c: ankle, side: "inside" })}
          value={value}
          tone={tone}
          unit={unit}
          size={labelSize}
        />
      ))}
    </g>
  );
}

interface AngleTagProps {
  a: Vec;
  vertex: Vec;
  c: Vec;
  value: number;
  tone: Tone;
  /** Which side of the bend the reading sits on. */
  side: "inside" | "outside";
  unit: number;
  size: number;
}

/** A wedge marking the measured angle, with its reading in a pill like the live overlay's. */
function AngleTag({ a, vertex, c, value, tone, side, unit, size }: AngleTagProps) {
  const v = toScreen(vertex);
  const toward = (p: Vec) => {
    const s = toScreen(p);
    const length = Math.hypot(s.x - v.x, s.y - v.y);
    return { x: (s.x - v.x) / length, y: (s.y - v.y) / length };
  };
  const ua = toward(a);
  const uc = toward(c);
  const radius = unit * 4.5;
  // Clockwise on screen when c is clockwise of a.
  const sweep = ua.x * uc.y - ua.y * uc.x > 0 ? 1 : 0;

  // A nearly straight joint has no clear bisector, so fall back to its perpendicular.
  let bx = ua.x + uc.x;
  let by = ua.y + uc.y;
  if (Math.hypot(bx, by) < 1e-3) [bx, by] = [-ua.y, ua.x];
  const bl = Math.hypot(bx, by);
  const dir = side === "inside" ? 1 : -1;
  [bx, by] = [(dir * bx) / bl, (dir * by) / bl];

  const text = `${Math.round(value)}°`;
  const width = size * (0.52 * text.length + 0.9);
  const height = size * 1.35;
  const reach = radius + unit + (Math.abs(bx) * width + Math.abs(by) * height) / 2;
  const cx = v.x + bx * reach;
  const cy = v.y + by * reach;

  return (
    <g>
      <path
        d={`M${v.x},${v.y} L${v.x + ua.x * radius},${v.y + ua.y * radius} A${radius},${radius} 0 0 ${sweep} ${v.x + uc.x * radius},${v.y + uc.y * radius} Z`}
        className={`${FILL[tone]} ${STROKE[tone]}`}
        fillOpacity={0.2}
        strokeWidth={unit * 0.45}
      />
      <rect
        x={cx - width / 2}
        y={cy - height / 2}
        width={width}
        height={height}
        rx={height / 2}
        className="fill-ink"
        opacity={0.88}
        stroke="none"
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size}
        className={`${FILL[tone]} font-display font-extrabold`}
        stroke="none"
      >
        {text}
      </text>
    </g>
  );
}
