import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

// A dropped frame (or a debugger pause) shouldn't make the animation skip ahead.
const MAX_STEP_MS = 100;

/**
 * Milliseconds into a looping animation. Time only advances while `playing`, the element is on
 * screen and the tab is visible, so nothing animates that nobody can see.
 */
export function useLoopTime(target: RefObject<Element | null>, duration: number, playing: boolean): number {
  const [time, setTime] = useState(0);
  const [onScreen, setOnScreen] = useState(false);
  const tabVisible = useSyncExternalStore(subscribeVisibility, () => !document.hidden);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? false));
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);

  const running = playing && onScreen && tabVisible;
  useEffect(() => {
    if (!running) return;
    let last: number | null = null;
    let frame = requestAnimationFrame(function tick(now) {
      const step = last === null ? 0 : Math.min(now - last, MAX_STEP_MS);
      last = now;
      setTime((t) => (t + step) % duration);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running, duration]);

  return time;
}
