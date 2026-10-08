import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getServices, ProjectNotFoundError } from "#/app/services";
import { ProjectLockedError } from "#/engine/persistence";
import { navigate } from "#/app/router";
import { useKeyboardShortcuts } from "#/app/actions";
import { useEditorState } from "#/app/hooks";
import { PANEL_CONSTRAINTS, setLayout, uiStore, type RightPanelTab } from "#/app/ui-state";
import { Icon } from "../icons";
import { Split } from "../primitives/split";
import { toast } from "../primitives/toast";
import { AgentPanel } from "../agent/AgentPanel";
import { AssetsPanel } from "../assets/AssetsPanel";
import { PreviewPanel } from "../preview/PreviewPanel";
import { PropertiesPanel } from "../properties/PropertiesPanel";
import { Timeline } from "../timeline/Timeline";
import { EditorHeader } from "./Header";
import { Button } from "../primitives/Button";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(window.innerWidth < 900);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

function RightPanel(): ReactNode {
  const tab = uiStore.use((s) => s.rightPanel);
  const tabs: ReadonlyArray<{ id: RightPanelTab; label: string }> = [{ id: "properties", label: "Properties" }, { id: "agent", label: "Agent" }];
  return (
    <div className="right-panel">
      <div role="tablist" aria-label="Side panel" className="right-panel__tabs">
        {tabs.map((t) => (
          <Button key={t.id} role="tab" aria-selected={tab === t.id} variant={tab === t.id ? "secondary" : "ghost"} size="sm" onClick={() => uiStore.set({ rightPanel: t.id })}>
            {t.label}
          </Button>
        ))}
      </div>
      <div className="right-panel__body">{tab === "agent" ? <AgentPanel /> : <PropertiesPanel />}</div>
    </div>
  );
}

function Layout(): ReactNode {
  const layout = uiStore.use((s) => s.layout);
  const narrow = useNarrow();
  const [pane, setPane] = useState<"preview" | "assets" | "properties" | "agent">("preview");

  if (narrow) {
    return (
      <Split direction="column" label="Editor" sizes={layout.vertical} constraints={PANEL_CONSTRAINTS.vertical} onChange={(vertical) => setLayout({ vertical })}>
        <div style={{ display: "flex", flexDirection: "column", width: "100%", padding: "0 0.5rem", gap: 4, minHeight: 0 }}>
          <div role="tablist" aria-label="Panels" style={{ display: "flex", gap: 4 }}>
            {(["preview", "assets", "properties", "agent"] as const).map((p) => (
              <Button key={p} role="tab" aria-selected={pane === p} variant={pane === p ? "secondary" : "ghost"} size="sm" onClick={() => setPane(p)}>
                {p === "preview" ? "Preview" : p === "assets" ? "Assets" : p === "properties" ? "Properties" : "Agent"}
              </Button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>{pane === "preview" ? <PreviewPanel /> : pane === "assets" ? <AssetsPanel /> : pane === "properties" ? <PropertiesPanel /> : <AgentPanel />}</div>
        </div>
        <div style={{ width: "100%", padding: "0 0.75rem 0.75rem", minHeight: 0, display: "flex" }}><div className="panel-box" style={{ width: "100%" }}><Timeline /></div></div>
      </Split>
    );
  }
  return (
    <Split direction="column" label="Editor" sizes={layout.vertical} constraints={PANEL_CONSTRAINTS.vertical} onChange={(vertical) => setLayout({ vertical })}>
      <div style={{ width: "100%", padding: "0 0.75rem", minHeight: 0, display: "flex" }}>
        <Split direction="row" label="Workspace" sizes={layout.horizontal} constraints={PANEL_CONSTRAINTS.horizontal} onChange={(horizontal) => setLayout({ horizontal })}>
          <AssetsPanel />
          <PreviewPanel />
          <RightPanel />
        </Split>
      </div>
      <div style={{ width: "100%", padding: "0 0.75rem 0.75rem", minHeight: 0, display: "flex" }}><div className="panel-box" style={{ width: "100%" }}><Timeline /></div></div>
    </Split>
  );
}

export function EditorPage({ id }: { id: string }): ReactNode {
  const services = getServices();
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "locked">("loading");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [recording, setRecording] = useState(false);
  const ready = useEditorState((s) => s.meta !== null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    let canceled = false;
    setStatus("loading");
    services.openProject(id).then(() => {
      if (canceled) return;
      setStatus("ready");
      const repairs = services.takeRepairNotes();
      if (repairs.length > 0) {
        toast.info(`Repaired ${repairs.length} ${repairs.length === 1 ? "issue" : "issues"} in this project`, repairs.slice(0, 3).join("; "));
      }
    }).catch(async (e: unknown) => {
      if (canceled) return;
      if (e instanceof ProjectNotFoundError) {
        const project = await services.projects.create("Untitled Project");
        navigate(`/editor/${project.metadata.id}`, { replace: true });
        return;
      }
      if (e instanceof ProjectLockedError) {
        setStatus("locked");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    });
    return () => {
      canceled = true;
      services.closeProject().catch((e: unknown) => toast.error("Could not save the project", e instanceof Error ? e.message : undefined));
    };
  }, [id, services, attempt]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (services.saveManager.isDirty) { e.preventDefault(); e.returnValue = ""; }
    };
    const onHide = (): void => { services.saveManager.flush().catch(() => undefined); };
    window.addEventListener("beforeunload", onBeforeUnload);
    const onVisibility = (): void => { if (document.visibilityState === "hidden") onHide(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [services]);

  useKeyboardShortcuts({ enabled: status === "ready" && ready, recording });
  const onRecording = useCallback((r: boolean) => setRecording(r), []);

  useEffect(() => {
    if (status === "ready" && services.storageMode === "indexeddb") toast.info("Using compatibility storage", "Your browser has no private file system, so media is stored in IndexedDB instead.");
  }, [status, services]);

  if (status === "locked") {
    return (
      <div className="loading-screen" role="alert">
        <strong>This project is open in another tab</strong>
        <p className="muted">Close it there, or switch to that tab, to keep your edits from overwriting each other.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
          <Button variant="outline" onClick={() => navigate("/projects")}>Back to projects</Button>
        </div>
      </div>
    );
  }
  if (status === "loading" || !ready) {
    return status === "error" ? (
      <div className="loading-screen"><p style={{ color: "var(--destructive)" }} role="alert">{error}</p><Button onClick={() => navigate("/projects")}>Back to projects</Button></div>
    ) : (
      <div className="loading-screen" role="status"><Icon name="loader" size={32} className="spin" /><span>Loading project...</span></div>
    );
  }
  return (
    <div className="editor">
      {!("VideoDecoder" in window) && !bannerDismissed ? (
        <div className="banner" role="status">
          For the best experience, open OpenCut in Chrome. This browser may not support video decoding.
          <Button variant="text" label="Dismiss" onClick={() => setBannerDismissed(true)}><Icon name="x" size={14} /></Button>
        </div>
      ) : null}
      <EditorHeader onRecording={onRecording} />
      <div className="editor__body"><Layout /></div>
    </div>
  );
}

