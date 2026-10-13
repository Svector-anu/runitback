import { lazy, Suspense, type ReactNode } from "react";

// The gallery (components, CSS, preview handling) is its own chunk so neither the editor nor the landing page carries it.
const TemplatesPage = lazy(() => import("./templates/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));

export function TemplatesPageEntry(): ReactNode {
  return (
    <Suspense fallback={<div className="landing-pending" aria-busy="true" />}>
      <TemplatesPage />
    </Suspense>
  );
}
