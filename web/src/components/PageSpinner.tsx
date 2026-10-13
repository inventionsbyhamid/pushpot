import { Spinner } from "./Spinner";

/** Centred loading state; pass `message` to show text, otherwise `label` is read to screen readers. */
export function PageSpinner({ label = "Loading", message }: { label?: string; message?: string }) {
  return (
    <div
      role="status"
      className="flex min-h-[40dvh] flex-col items-center justify-center gap-3 text-mute"
    >
      <Spinner className="size-7" />
      {message ? <p>{message}</p> : <span className="sr-only">{label}</span>}
    </div>
  );
}
