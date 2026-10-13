import { useRef, type KeyboardEvent } from "react";
import type { Cadence } from "../../lib/types";
import { cadences } from "./cadences";

interface CadenceTabsProps {
  value: Cadence;
  onChange: (cadence: Cadence) => void;
  /** Prefix for the tab ids, which the tab panel refers to. */
  idBase: string;
  panelId: string;
}

export const tabId = (idBase: string, cadence: Cadence) => `${idBase}-${cadence}`;

/** A segmented tab bar; arrow keys, Home and End move between tabs and select them. */
export function CadenceTabs({ value, onChange, idBase, panelId }: CadenceTabsProps) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent) => {
    const at = cadences.findIndex((c) => c.id === value);
    const last = cadences.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    const target = next === undefined ? undefined : cadences[next];
    if (next === undefined || !target) return;
    event.preventDefault();
    onChange(target.id);
    tabs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Challenge length"
      onKeyDown={onKeyDown}
      className="flex gap-1 rounded-xl border border-line bg-panel p-1"
    >
      {cadences.map((cadence, i) => {
        const selected = cadence.id === value;
        return (
          <button
            key={cadence.id}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, cadence.id)}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(cadence.id)}
            className="min-h-11 flex-auto rounded-lg px-2 font-display text-base leading-none font-extrabold text-mute transition-colors hover:bg-raised hover:text-chalk aria-selected:bg-volt aria-selected:text-ink"
          >
            {cadence.label}
          </button>
        );
      })}
    </div>
  );
}
