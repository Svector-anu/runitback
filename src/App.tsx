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

  let page: ReactNode;
  switch (route.name) {
    case "landing": page = <Landing />; break;
    case "projects": page = <ProjectsPage />; break;
    case "editor": page = <Suspense fallback={<div className="loading-screen" role="status">Loading editor...</div>}><EditorPage key={route.id} id={route.id} /></Suspense>; break;
    case "not-found":
      page = <div className="loading-screen"><h1>Page not found</h1><Button onClick={() => navigate("/projects")}>Go to projects</Button></div>;
  }
  const exit = { label: "Back to projects", run: () => navigate("/projects") };
  return (
    <>
      <ErrorBoundary key={route.name === "editor" ? `editor:${route.id}` : route.name} scope={route.name === "editor" ? "the editor" : "this page"}
        reloadLabel={route.name === "editor" ? "Reload project" : "Reload page"} onExit={route.name === "projects" ? undefined : exit}>
        {page}
      </ErrorBoundary>
      <Toaster />
    </>
  );
}
