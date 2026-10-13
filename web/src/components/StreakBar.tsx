import type { PeriodMark } from "../lib/pot";

const markClass: Record<PeriodMark, string> = {
  done: "bg-volt",
  missed: "bg-flare",
  late: "bg-amber/70",
  live: "border-2 border-amber",
  future: "bg-line",
};

/** Periods as chalk tally marks, grouped in fives. */
export function StreakBar({ marks, label }: { marks: PeriodMark[]; label: string }) {
  const groups: PeriodMark[][] = [];
  marks.forEach((mark, i) => {
    if (i % 5 === 0) groups.push([]);
    groups[groups.length - 1]?.push(mark);
  });

  return (
    <div role="img" aria-label={label} className="flex flex-wrap gap-x-2 gap-y-1.5">
      {groups.map((group, g) => (
        <span key={g} className="flex gap-[3px]">
          {group.map((mark, i) => (
            <span key={i} className={`h-4 w-1.5 -skew-x-12 rounded-[1px] ${markClass[mark]}`} />
          ))}
        </span>
      ))}
    </div>
  );
}
