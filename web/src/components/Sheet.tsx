import { useEffect, useId, useRef, type ReactNode } from "react";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** When false, Escape and backdrop taps are ignored, e.g. while a transaction is in flight. */
  dismissible?: boolean;
  children: ReactNode;
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Sheet({ open, onClose, title, dismissible = true, children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Focus the sheet itself rather than its first button, so nothing looks pre-selected.
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
      className="m-0 mt-auto max-h-[92dvh] w-full outline-none max-w-none bg-transparent p-0 text-chalk backdrop:bg-black/65 open:animate-sheet-up sm:m-auto sm:max-w-md"
    >
      <div className="mx-auto max-h-[92dvh] max-w-md overflow-y-auto rounded-t-2xl border border-b-0 border-line bg-panel px-4 pt-3 pb-safe sm:rounded-2xl sm:border-b">
        <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between gap-4">
          <h2 id={titleId} className="font-display text-[2rem] leading-tight font-extrabold">
            {title}
          </h2>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-xl text-mute hover:bg-raised hover:text-chalk"
            >
              ✕
            </button>
          )}
        </div>
        {children}
      </div>
    </dialog>
  );
}
