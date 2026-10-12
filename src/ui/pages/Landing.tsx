import { lazy, Suspense, type ReactNode } from "react";

// The landing page (components, CSS, fonts) is its own chunk so the editor bundle never carries it.
const LandingPage = lazy(() => import("./landing/LandingPage").then((m) => ({ default: m.LandingPage })));

export function Landing(): ReactNode {
  return (
    <Suspense fallback={<div className="landing-pending" aria-busy="true" />}>
      <LandingPage />
    </Suspense>
  );
}
