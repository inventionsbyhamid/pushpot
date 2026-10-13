import { Suspense } from "react";
import { Outlet, ScrollRestoration } from "react-router";
import { InAppBrowserBanner } from "./InAppBrowserBanner";
import { PageSpinner } from "./PageSpinner";
import { Toaster } from "./Toaster";

export function RootLayout() {
  return (
    <>
      <InAppBrowserBanner />
      <Suspense fallback={<PageSpinner />}>
        <Outlet />
      </Suspense>
      <Toaster />
      <ScrollRestoration />
    </>
  );
}
