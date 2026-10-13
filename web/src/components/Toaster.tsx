import { dismissToast, useToasts, type ToastTone } from "../lib/toast";

const toneClass: Record<ToastTone, string> = {
  info: "border-line",
  success: "border-volt/60",
  error: "border-flare/60",
};

export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex flex-col items-center gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))]"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismissToast(t.id)}
          className={`pointer-events-auto w-full max-w-md animate-toast-in rounded-xl border bg-raised/95 px-4 py-3 text-left font-medium shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop-blur ${toneClass[t.tone]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
