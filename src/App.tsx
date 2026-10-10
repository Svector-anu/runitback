import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { hydrateUiState } from "#/app/ui-state";
import { loadKeybindings } from "#/app/actions";
import { useRoute, navigate } from "#/app/router";
import { getServices } from "#/app/services";
import { Landing } from "#/ui/pages/Landing";
import { ProjectsPage } from "#/ui/pages/ProjectsPage";
import { Toaster } from "#/ui/primitives/toast";
import { Button } from "#/ui/primitives/Button";
import { ErrorBoundary } from "#/ui/primitives/ErrorBoundary";

const EditorPage = lazy(() => import("#/ui/editor/EditorPage").then((m) => ({ default: m.EditorPage })));

hydrateUiState();
loadKeybindings();

export function App(): ReactNode {
  const route = useRoute();
  useEffect(() => {
    const { editor, prefs } = getServices();
    return editor.subscribe(() => {
      const s = editor.getState();
      prefs.write("snapping", s.snappingEnabled);
      prefs.write("ripple", s.rippleEnabled);
    });
  }, []);

  // Landing is a real pathname (`/` with no hash), not a hash route: a bare `/app` load, or any
  // non-empty hash on `/`, falls through to the app shell switch below instead.
  const showLanding = location.pathname === "/" && location.hash === "";

  let page: ReactNode;
  if (showLanding) {
    page = <Landing />;
  } else {
    switch (route.name) {
      case "projects": page = <ProjectsPage />; break;
      case "editor": page = <Suspense fallback={<div className="loading-screen" role="status">Loading editor...</div>}><EditorPage key={route.id} id={route.id} /></Suspense>; break;
      case "not-found":
        page = <div className="loading-screen"><h1>Page not found</h1><Button onClick={() => navigate("/projects")}>Go to projects</Button></div>;
    }
  }
  const exit = { label: "Back to projects", run: () => navigate("/projects") };
  const errorKey = showLanding ? "landing" : route.name === "editor" ? `editor:${route.id}` : route.name;
  return (
    <>
      <ErrorBoundary key={errorKey} scope={!showLanding && route.name === "editor" ? "the editor" : "this page"}
        reloadLabel={!showLanding && route.name === "editor" ? "Reload project" : "Reload page"}
        onExit={!showLanding && route.name === "projects" ? undefined : exit}>
        {page}
      </ErrorBoundary>
      <Toaster />
    </>
  );
}
