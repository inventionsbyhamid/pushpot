import type { FigureKind } from "./FormFigure";

export interface Tip {
  title: string;
  detail: string;
  figures?: FigureKind[];
}

// Lists are in priority order: the workout prep card shows the first few of each.

export const DOS: Tip[] = [
  {
    title: "Hold one straight line",
    detail: "From head to heels. Squeeze your glutes, brace your core.",
    figures: ["plank"],
  },
  { title: "Go all the way down", detail: "Elbows to about 90° on every rep.", figures: ["bottom"] },
  { title: "Lock out at the top", detail: "Straight arms before the next rep starts." },
  { title: "Own the tempo", detail: "1 to 2 seconds down, about 1 second up." },
  { title: "Keep your hands planted", detail: "Set them once and leave them there." },
  { title: "Look a little ahead", detail: "Eyes on the floor just past your hands, neck long." },
];

export const DONTS: Tip[] = [
  {
    title: "Let your hips sag or pike",
    detail: "The counter checks your body line. Bent in the middle means no rep.",
    figures: ["sag", "pike"],
  },
  {
    title: "Cut reps short",
    detail: "No full depth or no lockout means no rep.",
    figures: ["half"],
  },
  { title: "Bounce or rush", detail: "Reps faster than half a second don't count." },
  { title: "Move your hands during a set", detail: "If your wrists drift, the rep doesn't count." },
  {
    title: "Drop your head",
    detail: "Look at the floor a little ahead of your hands.",
    figures: ["headDrop"],
  },
  { title: "Push through sharp pain", detail: "Stop. Burning muscles are fine, sharp pain is not." },
];

export const CAMERA_TIPS: Tip[] = [
  {
    title: "Phone on the floor, landscape",
    detail: "Prop it up about 2 m (6 to 7 ft) to your side.",
  },
  { title: "Your whole body in frame", detail: "Head to heels, sideways to the camera." },
  { title: "Light on you", detail: "Good light, and no bright window behind you." },
  { title: "Fitted clothes", detail: "Baggy tops hide your elbows and hips." },
  { title: "Front camera", detail: "So you can see yourself and the count." },
  { title: "Let it lock on", detail: "The app checks your framing before it starts counting." },
];
