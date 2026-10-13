import { useId, type ReactNode } from "react";
import { CAMERA_TIPS, DONTS, DOS, type Tip } from "./content";
import { ElbowAngleDiagram, SetupDiagram } from "./diagrams";
import { FormFigure } from "./FormFigure";
import { CheckIcon, CrossIcon } from "./icons";

/** Heading level for a section, so it nests under a page title or inside a sheet. */
type Level = 2 | 3;

interface SectionProps {
  level?: Level;
  className?: string;
}

function Section({
  title,
  level = 2,
  className = "",
  children,
}: SectionProps & { title: string; children: ReactNode }) {
  const id = useId();
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id} className={className}>
      <Heading
        id={id}
        className={`font-display leading-tight font-extrabold ${level === 2 ? "text-4xl" : "text-3xl"}`}
      >
        {title}
      </Heading>
      {children}
    </section>
  );
}

const STEPS: { title: string; detail: string; extra?: ReactNode }[] = [
  {
    title: "Set your hands",
    detail: "Just wider than your shoulders, wrists under your shoulders, fingers pointing forward.",
  },
  {
    title: "Make one straight line",
    detail: "From head to heels. Squeeze your glutes and brace your core.",
  },
  {
    title: "Lower to 90°",
    detail: "Control it down until your elbows hit about 90°, chest about a fist from the floor.",
  },
  {
    title: "Press to straight arms",
    detail: "Push the floor away until your arms are straight. That's one rep.",
  },
  {
    title: "Elbows at 45°",
    detail: "Tuck them about 45° from your body: an arrow, not a T.",
    extra: <ElbowAngleDiagram />,
  },
  {
    title: "Breathe and pace it",
    detail: "In on the way down, out on the way up. About 1 to 2 seconds down, 1 second up.",
  },
];

export function TechniqueSteps(props: SectionProps) {
  return (
    <Section title="The perfect rep" {...props}>
      <ol className="mt-5 space-y-5">
        {STEPS.map((step, i) => (
          <li key={step.title} className="grid grid-cols-[3rem_1fr] gap-x-3">
            <span aria-hidden className="font-display text-5xl leading-[0.9] font-black text-volt">
              {i + 1}
            </span>
            <div>
              <p className="font-display text-2xl leading-tight font-extrabold">{step.title}</p>
              <p className="text-mute">{step.detail}</p>
              {step.extra && <div className="mt-3">{step.extra}</div>}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function TipList({ tips, withFigures = false }: { tips: Tip[]; withFigures?: boolean }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {tips.map((tip) => (
        <li key={tip.title} className="py-3">
          <p className="font-semibold">{tip.title}</p>
          <p className="text-mute">{tip.detail}</p>
          {withFigures && tip.figures && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {tip.figures.map((kind) => (
                <FormFigure key={kind} kind={kind} className="w-full" />
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function DosAndDonts(props: SectionProps) {
  const Sub = props.level === 3 ? "h4" : "h3";
  const columns = [
    { heading: "Do", tips: DOS, icon: <CheckIcon className="size-6" />, tone: "text-volt" },
    { heading: "Don't", tips: DONTS, icon: <CrossIcon className="size-6" />, tone: "text-flare" },
  ];
  return (
    <Section title="Do this, not that" {...props}>
      {/* Two columns only where the container has room for both figures side by side. */}
      <div className="@container mt-5">
        <div className="grid gap-8 @2xl:grid-cols-2 @2xl:gap-6">
          {columns.map(({ heading, tips, icon, tone }) => (
            <div key={heading}>
              <Sub className={`mb-2 flex items-center gap-2 font-display text-3xl leading-none font-black ${tone}`}>
                {icon}
                {heading}
              </Sub>
              <TipList tips={tips} withFigures />
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

export function CameraSetup(props: SectionProps) {
  return (
    <Section title="Set up the camera" {...props}>
      <div className="mt-4 mb-4">
        <SetupDiagram />
      </div>
      <TipList tips={CAMERA_TIPS} />
    </Section>
  );
}

const RULES = [
  { label: "Down", detail: "Elbow bends below", value: "100°" },
  { label: "Up", detail: "Elbow straightens past", value: "150°" },
  { label: "Body line", detail: "Stays straight, at least", value: "145°" },
  { label: "Pace", detail: "Each rep takes at least", value: "0.5 s" },
];

export function HowWeCount(props: SectionProps) {
  return (
    <Section title="How a rep counts" {...props}>
      <p className="mt-2 text-mute">A rep counts only when all four check out.</p>
      <dl className="dot-matrix mt-4 divide-y divide-dashed divide-line rounded-2xl border border-line bg-panel">
        {RULES.map((rule) => (
          <div key={rule.label} className="flex items-center justify-between gap-4 px-4 py-3">
            <div>
              <dt className="font-display text-2xl leading-tight font-extrabold">{rule.label}</dt>
              <dd className="text-sm text-mute">{rule.detail}</dd>
            </div>
            <dd className="font-display text-4xl leading-none font-black text-volt tabular-nums">{rule.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4">
        Counting happens on your phone. To verify your set, we send only a compact trace of joint
        angles, never video.
      </p>
      <p className="mt-3">
        Knee pushups don't count in pots. Practice mode is fine for building up to full ones.
      </p>
    </Section>
  );
}

const LADDER = [
  { title: "Start in practice mode", detail: "No stakes, no wallet. Find out how many clean reps you've got." },
  { title: "Do sets of 5", detail: "Rest 30 to 60 seconds between sets until you reach your total." },
  { title: "Pick a Rookie daily challenge", detail: "A small target every day builds the habit." },
  { title: "Add a few reps each week", detail: "Small jumps stick. Big jumps hurt." },
];

export function ScaleUp(props: SectionProps) {
  return (
    <Section title="Can't do 20 yet?" {...props}>
      <ol className="mt-4 space-y-4">
        {LADDER.map((rung, i) => (
          <li key={rung.title} className="grid grid-cols-[2rem_1fr] gap-x-3">
            <span aria-hidden className="font-display text-3xl leading-none font-black text-volt">
              {i + 1}
            </span>
            <div>
              <p className="font-semibold">{rung.title}</p>
              <p className="text-mute">{rung.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function SafetyNote(props: SectionProps) {
  return (
    <Section
      title="Train safe"
      {...props}
      className={`rounded-2xl border border-amber/40 bg-panel px-4 py-4 [&>:first-child]:text-2xl [&>:first-child]:text-amber ${props.className ?? ""}`}
    >
      <p className="mt-1 text-mute">
        Warm up first with arm circles and a few easy reps. Stop if you feel sharp pain. This is
        general fitness guidance, not medical advice.
      </p>
    </Section>
  );
}

/** Everything about doing pushups the way the counter wants them. */
export function FormGuide({ className = "" }: { className?: string }) {
  return (
    <div className={`space-y-14 ${className}`}>
      <TechniqueSteps />
      <DosAndDonts />
      <CameraSetup />
      <HowWeCount />
      <ScaleUp />
      <SafetyNote />
    </div>
  );
}
