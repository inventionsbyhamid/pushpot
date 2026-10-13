const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.25,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function CloseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6" {...stroke}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function SwitchCameraIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-6" {...stroke}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <path d="M9.5 11.5a3 3 0 0 1 5-1.2l.5.5M14.5 14.5a3 3 0 0 1-5 1.2l-.5-.5M15 9v2h-2M9 17v-2h2" />
    </svg>
  );
}

export function RotateIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-5" {...stroke}>
      <rect x="3" y="10" width="14" height="10" rx="2" />
      <path d="M8 4h6a5 5 0 0 1 5 5v1M17 8l2 2 2-2" />
    </svg>
  );
}
