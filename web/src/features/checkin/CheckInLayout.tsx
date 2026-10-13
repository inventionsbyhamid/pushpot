import type { ReactNode } from "react";
import { Link } from "react-router";

/** Full-height frame for the steps around a pot workout, with a way back to the pot. */
export function CheckInLayout({ potId, children }: { potId: number; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-safe">
      <nav className="flex h-16 items-center">
        <Link
          to={`/p/${potId}`}
          className="-ml-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-mute hover:text-chalk"
        >
          <span aria-hidden className="text-xl">
            ‹
          </span>
          Back to pot
        </Link>
      </nav>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
