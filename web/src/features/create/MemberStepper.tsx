import { useState, type ReactNode } from "react";
import { MAX_MEMBERS, MIN_MEMBERS } from "./options";

const clamp = (n: number) => Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, Math.round(n)));

export function MemberStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <fieldset>
      <legend className="mb-2 font-semibold">Max players</legend>
      <div className="flex items-center gap-2">
        <StepButton
          label="Fewer players"
          disabled={value <= MIN_MEMBERS}
          onClick={() => onChange(clamp(value - 1))}
        >
          −
        </StepButton>
        <input
          aria-label="Max players"
          type="number"
          inputMode="numeric"
          min={MIN_MEMBERS}
          max={MAX_MEMBERS}
          value={draft ?? value}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = Number(e.target.value);
            if (Number.isInteger(n) && n >= MIN_MEMBERS && n <= MAX_MEMBERS) onChange(n);
          }}
          onBlur={() => setDraft(null)}
          className="h-14 min-w-0 flex-1 rounded-[0.625rem] border border-line bg-panel text-center font-display text-4xl font-black text-chalk focus:border-volt focus:outline-none"
        />
        <StepButton
          label="More players"
          disabled={value >= MAX_MEMBERS}
          onClick={() => onChange(clamp(value + 1))}
        >
          +
        </StepButton>
      </div>
      <p className="mt-2 text-sm text-mute">
        Including you, {MIN_MEMBERS} to {MAX_MEMBERS}.
      </p>
    </fieldset>
  );
}

interface StepButtonProps {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}

function StepButton({ label, disabled, onClick, children }: StepButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-14 shrink-0 place-items-center rounded-[0.625rem] border border-line bg-raised font-display text-3xl font-black text-chalk active:bg-line disabled:opacity-35"
    >
      {children}
    </button>
  );
}
