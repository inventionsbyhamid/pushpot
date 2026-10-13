import { isRouteErrorResponse, useRouteError } from "react-router";
import { Button } from "./Button";

export function RouteError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : null;

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="font-display text-5xl font-black">Something broke.</h1>
      <p className="mt-3 text-mute">
        Reload the page to try again. Your funds are safe in the contract.
      </p>
      {detail && <p className="mt-4 font-mono text-sm break-words text-mute">{detail}</p>}
      <Button className="mt-8 w-full" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </main>
  );
}
