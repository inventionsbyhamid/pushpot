import { useId, type ReactNode } from "react";

export interface ChipOption<T extends string | number | bigint> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}

interface ChipGroupProps<T extends string | number | bigint> {
  legend: string;
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Grid columns on phone width. */
  columns?: 2 | 3 | 4;
  children?: ReactNode;
}

const columnClass = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" } as const;

/** A radio group drawn as chunky chips; arrow keys move between options natively. */
export function ChipGroup<T extends string | number | bigint>({
  legend,
  options,
  value,
  onChange,
  columns = 4,
  children,
}: ChipGroupProps<T>) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-2 font-semibold">{legend}</legend>
      <div className={`grid gap-2 ${columnClass[columns]}`}>
        {options.map((option) => (
          <label
            key={String(option.value)}
            className="flex min-h-14 cursor-pointer flex-col items-center justify-center rounded-[0.625rem] border border-line bg-panel px-2 py-2 text-center transition-colors select-none hover:border-mute has-checked:border-volt has-checked:bg-volt has-checked:text-ink has-disabled:cursor-not-allowed has-disabled:opacity-35 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-volt"
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={option.value === value}
              disabled={option.disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="font-display text-2xl leading-none font-extrabold">
              {option.label}
            </span>
            {option.hint && (
              <span className="mt-1 text-xs leading-tight opacity-75">{option.hint}</span>
            )}
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}
