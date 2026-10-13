import confetti from "canvas-confetti";
import type { Cue } from "../../pose/repCounter";

export const CUE_TEXT: Record<Cue, string> = {
  go_lower: "Go lower",
  lock_out: "Lock out at the top",
  hips_sag: "Hips sagging",
  hips_pike: "Hips too high",
  move_into_frame: "Move into frame",
  get_in_plank: "Get into a plank",
};

/** Form faults on a rep, as opposed to setup guidance. */
export function isFault(cue: Cue): boolean {
  return cue === "go_lower" || cue === "lock_out" || cue === "hips_sag" || cue === "hips_pike";
}

/** Reads a theme color token, for drawing APIs that can't resolve CSS variables. */
export function themeColor(token: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim() || fallback;
}

export interface Beeper {
  /** Creates or resumes the audio context; call from a user gesture. */
  unlock(): void;
  beep(final?: boolean): void;
  close(): void;
}

/**
 * A single oscillator built once and gated by a gain envelope, so a beep costs nothing at rep
 * time and plays on iOS once unlocked by a tap.
 */
export function createBeeper(): Beeper {
  let context: AudioContext | null = null;
  let oscillator: OscillatorNode | null = null;
  let gain: GainNode | null = null;

  return {
    unlock() {
      if (typeof AudioContext === "undefined") return;
      if (!context) {
        context = new AudioContext();
        gain = context.createGain();
        gain.gain.value = 0;
        oscillator = context.createOscillator();
        oscillator.type = "triangle";
        oscillator.connect(gain).connect(context.destination);
        oscillator.start();
      }
      void context.resume();
    },

    beep(final = false) {
      if (!context || !oscillator || !gain) return;
      if (context.state !== "running") void context.resume();
      const now = context.currentTime;
      oscillator.frequency.setValueAtTime(final ? 1320 : 880, now);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (final ? 0.45 : 0.14));
    },

    close() {
      oscillator?.stop();
      void context?.close();
      context = null;
      oscillator = null;
      gain = null;
    },
  };
}

export function pulse(): void {
  navigator.vibrate?.(30);
}

export function celebrate(): void {
  void confetti({
    particleCount: 160,
    spread: 80,
    startVelocity: 48,
    origin: { y: 0.7 },
    colors: [themeColor("volt", "#ccff2e"), themeColor("chalk", "#f1efe6"), themeColor("amber", "#ffb020")],
    disableForReducedMotion: true,
  });
}

export interface ScreenWakeLock {
  acquire(): void;
  release(): void;
}

/** Keeps the screen on while held, re-acquiring it when the page becomes visible again. */
export function createWakeLock(): ScreenWakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;

  async function request(): Promise<void> {
    if (!wanted || sentinel || document.hidden || !("wakeLock" in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!wanted) {
        void lock.release();
        return;
      }
      sentinel = lock;
      lock.addEventListener("release", () => {
        if (sentinel === lock) sentinel = null;
      });
    } catch {
      // Denied (e.g. battery saver) or unsupported; the workout still works with the screen dimming.
    }
  }

  const onVisibility = () => void request();

  return {
    acquire() {
      if (wanted) return;
      wanted = true;
      document.addEventListener("visibilitychange", onVisibility);
      void request();
    },
    release() {
      wanted = false;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release();
      sentinel = null;
    },
  };
}
