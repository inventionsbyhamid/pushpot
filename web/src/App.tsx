import { lazy } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";
import { AppShell } from "./components/AppShell";
import { RootLayout } from "./components/RootLayout";
import { RouteError } from "./components/RouteError";
import NotFound from "./pages/NotFound";

const Home = lazy(() => import("./pages/Home"));
const Practice = lazy(() => import("./pages/Practice"));
const CreatePot = lazy(() => import("./pages/CreatePot"));
const PotPage = lazy(() => import("./pages/PotPage"));
const PotWorkout = lazy(() => import("./pages/PotWorkout"));

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Home /> },
          { path: "create", element: <CreatePot /> },
          { path: "p/:id", element: <PotPage /> },
          { path: "*", element: <NotFound /> },
        ],
      },
      // Camera screens run full-bleed, without the app header.
      { path: "practice", element: <Practice /> },
      { path: "p/:id/workout", element: <PotWorkout /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
