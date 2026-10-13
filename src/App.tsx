import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { hydrateUiState } from "#/app/ui-state";
import { loadKeybindings } from "#/app/actions";
import { useRoute, navigate } from "#/app/router";
import { getServices } from "#/app/services";
import { Landing } from "#/ui/pages/Landing";
import { TemplatesPageEntry } from "#/ui/pages/TemplatesPageEntry";
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

  // `/templates` is a second marketing pathname (like `/app` it needs a rewrite in vercel.json); `/#/templates` reaches the same page.
  const showGallery = !showLanding && ((location.pathname === "/templates" && location.hash === "") || route.name === "templates");

  let page: ReactNode;
  if (showLanding) {
    page = <Landing />;
  } else if (showGallery) {
    page = <TemplatesPageEntry />;
  } else {
    switch (route.name) {
      case "projects": page = <ProjectsPage />; break;
      case "editor": page = <Suspense fallback={<div className="loading-screen" role="status">Loading editor...</div>}><EditorPage key={route.id} id={route.id} template={route.template} /></Suspense>; break;
      case "templates": break;
      case "not-found":
        page = <div className="loading-screen"><h1>Page not found</h1><Button onClick={() => navigate("/projects")}>Go to projects</Button></div>;
    }
  }
  const exit = { label: "Back to projects", run: () => navigate("/projects") };
  const errorKey = showLanding ? "landing" : showGallery ? "templates" : route.name === "editor" ? `editor:${route.id}` : route.name;
  return (
    <>
      <ErrorBoundary key={errorKey} scope={!showLanding && !showGallery && route.name === "editor" ? "the editor" : "this page"}
        reloadLabel={!showLanding && !showGallery && route.name === "editor" ? "Reload project" : "Reload page"}
        onExit={!showLanding && !showGallery && route.name === "projects" ? undefined : exit}>
        {page}
      </ErrorBoundary>
      <Toaster />
    </>
  );
}
