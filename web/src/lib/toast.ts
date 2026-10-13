import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

const DURATION_MS = 4_000;
const MAX_VISIBLE = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: Toast[]) {
  toasts = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number) {
  emit(toasts.filter((t) => t.id !== id));
}

export function toast(message: string, tone: ToastTone = "info") {
  const id = nextId++;
  emit([{ id, message, tone }, ...toasts].slice(0, MAX_VISIBLE));
  window.setTimeout(() => dismissToast(id), DURATION_MS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}
