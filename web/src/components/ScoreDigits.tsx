/**
 * Scoreboard numerals. The display face has proportional figures, so each digit gets a fixed
 * cell to stop countdowns from jittering, and changed digits flip in.
 */
export function ScoreDigits({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span className={className}>
      <span className="sr-only">{value}</span>
      <span aria-hidden className="inline-flex items-baseline">
        {[...value].map((char, i) =>
          /\d/.test(char) ? (
            <span key={`${i}${char}`} className="inline-block w-[0.62em] animate-flip text-center">
              {char}
            </span>
          ) : (
            <span key={`${i}${char}`} className={char === " " ? "w-[0.25em]" : undefined}>
              {char}
            </span>
          ),
        )}
      </span>
    </span>
  );
}
