import { lazy, Suspense } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";

const Home = lazy(() => import("./pages/Home"));
const Practice = lazy(() => import("./pages/Practice"));
const CreatePot = lazy(() => import("./pages/CreatePot"));
const PotPage = lazy(() => import("./pages/PotPage"));
const PotWorkout = lazy(() => import("./pages/PotWorkout"));

const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/practice", element: <Practice /> },
  { path: "/create", element: <CreatePot /> },
  { path: "/p/:id", element: <PotPage /> },
  { path: "/p/:id/workout", element: <PotWorkout /> },
]);

export default function App() {
  return (
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
