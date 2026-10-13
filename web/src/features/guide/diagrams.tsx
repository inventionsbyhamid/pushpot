import { CheckIcon, CrossIcon } from "./icons";

const DEG = Math.PI / 180;

/** Seen from above, the upper arms make an arrow with the body when tucked and a T when flared. */
export function ElbowAngleDiagram() {
  return (
    <div
      role="img"
      aria-label="Seen from above: elbows tucked about 45 degrees make an arrow, which is right. Elbows flared straight out make a T, which is wrong."
      className="grid max-w-72 grid-cols-2 gap-3"
    >
      <TopDown flare={45} good />
      <TopDown flare={90} good={false} />
    </div>
  );
}

function TopDown({ flare, good }: { flare: number; good: boolean }) {
  const shoulders = [-1, 1].map((side) => ({ side, x: 40 + side * 12, y: 26 }));
  const arm = 20;
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg bg-panel pt-2 pb-2.5">
      <svg aria-hidden viewBox="0 0 80 74" className="w-full max-w-32" strokeLinecap="round" fill="none">
        <g className="stroke-chalk opacity-20">
          <line x1={40} y1={26} x2={40} y2={66} strokeWidth={15} />
          <line x1={36} y1={64} x2={35} y2={80} strokeWidth={7} />
          <line x1={44} y1={64} x2={45} y2={80} strokeWidth={7} />
          <circle cx={40} cy={13} r={7} className="fill-chalk" stroke="none" />
        </g>
        <line x1={28} y1={26} x2={52} y2={26} className="stroke-chalk/60" strokeWidth={1.2} />
        <line x1={40} y1={26} x2={40} y2={66} className="stroke-chalk/60" strokeWidth={1.2} />
        {shoulders.map(({ side, x, y }) => {
          const ex = x + side * arm * Math.sin(flare * DEG);
          const ey = y + arm * Math.cos(flare * DEG);
          return (
            <g key={side} className={good ? "stroke-volt" : "stroke-flare"}>
              <line x1={x} y1={y} x2={ex} y2={ey} strokeWidth={3} />
              <circle cx={ex} cy={ey} r={2.4} className={good ? "fill-volt" : "fill-flare"} />
            </g>
          );
        })}
      </svg>
      <p
        className={`inline-flex items-center gap-1.5 font-display text-xl leading-none font-extrabold ${good ? "text-volt" : "text-flare"}`}
      >
        {good ? <CheckIcon className="size-4" /> : <CrossIcon className="size-4" />}
        {good ? "Arrow, 45°" : "T, 90°"}
      </p>
    </div>
  );
}

/** Seen from above: the phone on the floor beside the athlete, its view taking in the whole body. */
export function SetupDiagram() {
  const lens = { x: 160, y: 112 };
  return (
    <svg
      role="img"
      aria-label="Seen from above: the phone lies on the floor in landscape about 2 metres to your side, and its view takes in your whole body from head to heels."
      viewBox="0 0 320 140"
      className="w-full rounded-xl bg-panel"
      strokeLinecap="round"
      fill="none"
    >
      <path d={`M${lens.x},${lens.y} L22,38 L298,38 Z`} className="fill-volt/8" />
      <path d={`M22,38 L${lens.x},${lens.y} L298,38`} className="stroke-volt/60" strokeWidth={1.2} strokeDasharray="4 4" />

      <g className="stroke-chalk opacity-25">
        <line x1={58} y1={34} x2={150} y2={36} strokeWidth={7} />
        <line x1={58} y1={44} x2={150} y2={42} strokeWidth={7} />
        <line x1={150} y1={39} x2={236} y2={39} strokeWidth={22} />
        <line x1={232} y1={28} x2={236} y2={18} strokeWidth={6} />
        <line x1={232} y1={50} x2={236} y2={60} strokeWidth={6} />
        <circle cx={258} cy={39} r={10} className="fill-chalk" stroke="none" />
      </g>

      <rect x={lens.x - 15} y={lens.y - 2} width={30} height={15} rx={3} className="fill-raised stroke-chalk/70" strokeWidth={1.2} />
      <circle cx={lens.x} cy={lens.y + 1.5} r={1.6} className="fill-volt" />

      <line x1={292} y1={46} x2={292} y2={110} className="stroke-mute" strokeWidth={1} />
      <line x1={286} y1={46} x2={298} y2={46} className="stroke-mute" strokeWidth={1} />
      <line x1={286} y1={110} x2={298} y2={110} className="stroke-mute" strokeWidth={1} />
      <text x={284} y={82} textAnchor="end" className="fill-chalk font-display font-extrabold" fontSize={15}>
        about 2 m
      </text>
      <text x={284} y={97} textAnchor="end" className="fill-mute" fontSize={10}>
        6 to 7 ft
      </text>
    </svg>
  );
}
