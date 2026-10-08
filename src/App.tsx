import { useEffect, type ReactNode } from "react";
import { hydrateUiState } from "#/app/ui-state";
import { loadKeybindings } from "#/app/actions";
import { useRoute, navigate } from "#/app/router";
import { getServices } from "#/app/services";
import { EditorPage } from "#/ui/editor/EditorPage";
import { Landing } from "#/ui/pages/Landing";
import { ProjectsPage } from "#/ui/pages/ProjectsPage";
import { Toaster } from "#/ui/primitives/toast";
import { Button } from "#/ui/primitives/Button";

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
    case "editor": page = <EditorPage key={route.id} id={route.id} />; break;
    case "not-found":
      page = <div className="loading-screen"><h1>Page not found</h1><Button onClick={() => navigate("/projects")}>Go to projects</Button></div>;
  }
  return <>{page}<Toaster /></>;
}
