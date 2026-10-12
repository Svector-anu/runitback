import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { filterProjects, sortProjects, type ProjectSortKey, type SortOrder, type UnreadableProject } from "#/engine/persistence";
import type { ProjectMetadata } from "#/engine/model";
import { getServices } from "#/app/services";
import type { BundleProgress } from "#/platform/bundle";
import { formatStorageBytes, type StorageEstimate } from "#/platform/file-store";
import { BUNDLE_EXTENSION, BundleError } from "#/engine/persistence";
import { navigate } from "#/app/router";
import { Store } from "#/app/store";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon, Logo } from "../icons";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { ContextMenu, DropdownMenu, type ContextMenuState, type MenuEntry } from "../primitives/Menu";
import { toast } from "../primitives/toast";
import { formatDuration } from "../assets/MediaView";
import { UnreadableProjectCard } from "./UnreadableProjectCard";

interface ViewPrefs { mode: "grid" | "list"; key: ProjectSortKey; order: SortOrder }
const isPrefs = (v: unknown): v is ViewPrefs => typeof v === "object" && v !== null && ["grid", "list"].includes((v as ViewPrefs).mode)
  && ["createdAt", "updatedAt", "name", "duration"].includes((v as ViewPrefs).key) && ["asc", "desc"].includes((v as ViewPrefs).order);
const prefsStore = new Store<ViewPrefs>({ mode: "grid", key: "updatedAt", order: "desc" });

const SORT_LABELS: Record<ProjectSortKey, string> = { createdAt: "Created", updatedAt: "Modified", name: "Name", duration: "Duration" };
const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

type Dialogs = { kind: "rename" | "delete" | "info" | "export"; projects: ProjectMetadata[] } | null;

interface Busy { kind: "export" | "import"; label: string; fraction: number | null }

function describeBundleError(error: unknown): string {
  if (error instanceof BundleError) return error.message;
  return error instanceof Error ? error.message : "Unexpected error";
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function ProjectCard({ project, selected, mode, onOpen, onToggle, onMenu }: {
  project: ProjectMetadata; selected: boolean; mode: "grid" | "list"; onOpen: () => void; onToggle: (shift: boolean) => void; onMenu: (x: number, y: number) => void;
}): ReactNode {
  const created = dateFormat.format(new Date(project.createdAt));
  const checkbox = (
    <input type="checkbox" className="checkbox project-card__check" checked={selected} aria-label={`Select ${project.name}`}
      onClick={(e) => { e.stopPropagation(); onToggle(e.shiftKey); }} onChange={() => undefined} />
  );
  if (mode === "list") {
    return (
      <div className="project-row" data-selected={selected} role="group" aria-label={`Project ${project.name}`} onClick={onOpen} onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}>
        <input type="checkbox" className="checkbox" checked={selected} aria-label={`Select ${project.name}`} onClick={(e) => { e.stopPropagation(); onToggle(e.shiftKey); }} onChange={() => undefined} />
        <div className="project-row__thumb">{project.thumbnail ? <img src={project.thumbnail} alt="" /> : null}</div>
        <button type="button" className="truncate project-card__open" style={{ flex: 1, fontWeight: 500 }} onClick={(e) => { e.stopPropagation(); onOpen(); }}>{project.name}</button>
        <span className="muted mono">{formatDuration(project.duration)}</span>
        <span className="muted">{created}</span>
      </div>
    );
  }
  return (
    <div className="project-card" data-selected={selected} role="group" aria-label={`Project ${project.name}`} onClick={onOpen}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}>
      <div className="project-card__thumb">
        {project.thumbnail ? <img src={project.thumbnail} alt="" /> : <Icon name="video" size={48} />}
        {checkbox}
        <Button variant="outline" size="icon" label={`Actions for ${project.name}`} className="project-card__menu" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom); }}>
          <Icon name="more" />
        </Button>
        <span className="project-card__duration">{formatDuration(project.duration)}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <button type="button" className="project-card__title project-card__open" onClick={(e) => { e.stopPropagation(); onOpen(); }}>{project.name}</button>
        <div className="project-card__meta"><Icon name="calendar" size={14} />Created {created}</div>
      </div>
    </div>
  );
}

export function ProjectsPage(): ReactNode {
  const services = getServices();
  const prefs = prefsStore.use((s) => s);
  const theme = uiStore.use((s) => s.theme);
  const [projects, setProjects] = useState<ProjectMetadata[] | null>(null);
  const [unreadable, setUnreadable] = useState<UnreadableProject[]>([]);
  const [discarding, setDiscarding] = useState<UnreadableProject | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<{ state: ContextMenuState; project: ProjectMetadata } | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [name, setName] = useState("");
  const anchor = useRef<string | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [includeEmbeddings, setIncludeEmbeddings] = useState(false);
  const [storage, setStorage] = useState<StorageEstimate | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const library = await services.projects.listLibrary();
      setProjects(library.projects);
      setUnreadable(library.unreadable);
    } catch (error) {
      toast.error("Could not load projects", error instanceof Error ? error.message : undefined);
      setProjects([]);
    }
  }, [services]);

  useEffect(() => {
    prefsStore.set(services.prefs.read("projects-view", prefsStore.get(), isPrefs));
    services.closeProject().then(load, (error: unknown) => {
      toast.error("Could not save the project you just left", error instanceof Error ? error.message : undefined);
      return load();
    }).then(() => services.purgeStrayDerivedData()).catch((error: unknown) => console.warn("Could not clean up derived data", error));
    void services.takeStorageNotice().then((notice) => { if (notice) toast.error("Storage is not durable", notice); });
  }, [services, load]);

  useEffect(() => {
    void services.storageEstimate().then(setStorage);
  }, [services, projects]);

  const onProgress = (kind: Busy["kind"]) => (p: BundleProgress): void => {
    setBusy({ kind, label: p.label ?? p.phase, fraction: p.total > 0 ? Math.min(1, p.done / p.total) : null });
  };

  const exportProject = async (project: ProjectMetadata): Promise<void> => {
    setBusy({ kind: "export", label: "Preparing", fraction: null });
    try {
      const result = await services.exportProject(project.id, { includeEmbeddings, onProgress: onProgress("export") });
      downloadBlob(result.blob, result.fileName);
      toast.success(`Exported ${project.name}`, result.missingAssets.length > 0 ? `${result.missingAssets.length} missing media file(s) were left out.` : undefined);
    } catch (error) {
      toast.error("Could not export the project", describeBundleError(error));
    } finally {
      setBusy(null);
    }
  };

  const importProject = async (file: File): Promise<void> => {
    setBusy({ kind: "import", label: file.name, fraction: null });
    try {
      const result = await services.importProject(file, { onProgress: onProgress("import") });
      toast.success(`Imported ${result.name}`);
      await load();
    } catch (error) {
      toast.error("Could not import the project", describeBundleError(error));
    } finally {
      setBusy(null);
    }
  };

  const setPrefs = (patch: Partial<ViewPrefs>): void => {
    prefsStore.set(patch);
    services.prefs.write("projects-view", prefsStore.get());
  };

  const visible = useMemo(() => sortProjects(filterProjects(projects ?? [], query), prefs.key, prefs.order), [projects, query, prefs.key, prefs.order]);

  const create = async (): Promise<void> => {
    try {
      const project = await services.projects.create("New project");
      navigate(`/editor/${project.metadata.id}`);
    } catch (error) {
      toast.error("Failed to save new project", error instanceof Error ? error.message : undefined);
    }
  };

  const toggle = (id: string, shift: boolean): void => {
    if (shift && anchor.current) {
      const a = visible.findIndex((p) => p.id === anchor.current);
      const b = visible.findIndex((p) => p.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected([...new Set([...selected, ...visible.slice(lo, hi + 1).map((p) => p.id)])]);
    } else {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
      anchor.current = id;
    }
  };

  const targets = (project: ProjectMetadata): ProjectMetadata[] =>
    selected.includes(project.id) ? visible.filter((p) => selected.includes(p.id)) : [project];

  const duplicate = async (list: ProjectMetadata[]): Promise<void> => {
    try {
      await services.projects.duplicate(list.map((p) => p.id));
      await load();
    } catch (error) {
      toast.error("Failed to duplicate", error instanceof Error ? error.message : undefined);
    }
  };
  const remove = async (list: ProjectMetadata[]): Promise<void> => {
    try {
      await services.projects.delete(list.map((p) => p.id));
      setSelected([]);
      await load();
    } catch (error) {
      toast.error("Failed to delete", error instanceof Error ? error.message : undefined);
    }
  };
  const rename = async (project: ProjectMetadata): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await services.projects.rename(project.id, trimmed);
      await load();
    } catch (error) {
      toast.error("Failed to rename project", error instanceof Error ? error.message : undefined);
    }
  };

  const exportRaw = async (project: UnreadableProject): Promise<void> => {
    try {
      const raw = await services.projects.loadRaw(project.id);
      if (raw === null) throw new Error("The stored data is gone");
      downloadBlob(new Blob([raw], { type: "application/json" }), `${project.name ?? project.id}.raw.json`);
    } catch (error) {
      toast.error("Could not export the raw data", error instanceof Error ? error.message : undefined);
    }
  };
  const discard = async (project: UnreadableProject): Promise<void> => {
    try {
      await services.projects.delete([project.id]);
      await load();
    } catch (error) {
      toast.error("Failed to delete", error instanceof Error ? error.message : undefined);
    }
  };

  const menuEntries = (project: ProjectMetadata): MenuEntry[] => {
    const list = targets(project);
    return [
      { label: "Rename", icon: "edit", disabled: list.length > 1, onSelect: () => { setName(project.name); setDialog({ kind: "rename", projects: [project] }); } },
      { label: list.length > 1 ? `Duplicate ${list.length} projects` : "Duplicate", icon: "copy", onSelect: () => void duplicate(list) },
      { label: "Export project", icon: "arrow-down", disabled: list.length > 1, onSelect: () => setDialog({ kind: "export", projects: [project] }) },
      { label: "Info", icon: "info", disabled: list.length > 1, onSelect: () => setDialog({ kind: "info", projects: [project] }) },
      { type: "separator" },
      { label: list.length > 1 ? `Delete ${list.length} projects` : "Delete", icon: "trash", destructive: true, onSelect: () => setDialog({ kind: "delete", projects: list }) },
    ];
  };

  const loading = projects === null;
  const empty = !loading && projects.length === 0 && unreadable.length === 0;
  const noResults = !loading && !empty && visible.length === 0 && projects.length > 0;
  const selectedProjects = visible.filter((p) => selected.includes(p.id));

  return (
    <div className="page">
      <header className="page__header">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="btn btn--text" onClick={() => navigate("/")}><Logo size={20} /></button>
          <button type="button" className="btn btn--text" onClick={() => navigate("/")}>Home</button>
          <Icon name="chevron-right" size={14} /><strong aria-current="page">All projects</strong>
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div className="view-toggle" role="group" aria-label="View mode">
            <Button variant={prefs.mode === "grid" ? "secondary" : "ghost"} size="icon" label="Grid view" aria-pressed={prefs.mode === "grid"} onClick={() => setPrefs({ mode: "grid" })}><Icon name="grid" /></Button>
            <Button variant={prefs.mode === "list" ? "secondary" : "ghost"} size="icon" label="List view" aria-pressed={prefs.mode === "list"} onClick={() => setPrefs({ mode: "list" })}><Icon name="list" /></Button>
          </div>
          <div className="search">
            <Icon name="search" />
            <input className="input" type="search" placeholder="Search projects..." aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button variant="ghost" size="icon-lg" label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={18} /></Button>
          <Button variant="outline" size="lg" onClick={() => importInput.current?.click()}>Import project</Button>
          <input ref={importInput} type="file" accept={BUNDLE_EXTENSION} hidden aria-label="Import project file"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importProject(f); }} />
          <Button size="lg" onClick={() => void create()}><Icon name="plus" />New project</Button>
        </div>
      </header>
      <div className="page__toolbar">
        <label style={{ display: "flex", gap: 8, alignItems: "center" }} className="muted">
          <input type="checkbox" className="checkbox" aria-label="Select all projects" checked={visible.length > 0 && selected.length === visible.length}
            onChange={(e) => setSelected(e.target.checked ? visible.map((p) => p.id) : [])} />Select all
        </label>
        <div className="timeline__divider" />
        <DropdownMenu width={192}
          entries={(Object.keys(SORT_LABELS) as ProjectSortKey[]).map((k) => ({ label: SORT_LABELS[k], checked: prefs.key === k, onSelect: () => setPrefs({ key: k }) }))}
          trigger={(p) => <Button {...p} variant="text">{SORT_LABELS[prefs.key]}</Button>} />
        <Button variant="text" label={prefs.order === "asc" ? "Sort ascending" : "Sort descending"} onClick={() => setPrefs({ order: prefs.order === "asc" ? "desc" : "asc" })}>
          <Icon name="arrow-down" style={{ transform: prefs.order === "asc" ? "rotate(180deg)" : undefined }} />
        </Button>
        {storage ? <span className="muted" data-testid="storage-usage">Storage: {formatStorageBytes(storage.usage)} of {formatStorageBytes(storage.quota)} used</span> : null}
        {selectedProjects.length > 0 ? (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Button variant="outline" size="icon-lg" label="Duplicate selected" onClick={() => void duplicate(selectedProjects)}><Icon name="copy" /></Button>
            <Button variant="destructive-outline" size="icon-lg" label="Delete selected" onClick={() => setDialog({ kind: "delete", projects: selectedProjects })}><Icon name="trash" /></Button>
          </div>
        ) : null}
      </div>
      <main className="page__main">
        {unreadable.length > 0 ? (
          <section aria-label="Projects that cannot be opened" className="project-grid" style={{ marginBottom: 24 }}>
            {unreadable.map((u) => (
              <UnreadableProjectCard key={u.id} project={u} onRetry={() => void load()} onExportRaw={() => void exportRaw(u)} onDelete={() => setDiscarding(u)} />
            ))}
          </section>
        ) : null}
        {loading ? (
          <div className="project-grid" aria-busy="true" aria-label="Loading projects">
            {Array.from({ length: 8 }, (_, i) => <div key={i}><div className="skeleton" style={{ aspectRatio: "16/9" }} /><div className="skeleton" style={{ height: 16, width: "75%", marginTop: 16 }} /><div className="skeleton" style={{ height: 16, width: 96, marginTop: 8 }} /></div>)}
          </div>
        ) : empty ? (
          <div className="empty" style={{ minHeight: "50vh" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "color-mix(in srgb, var(--muted) 30%, transparent)", display: "grid", placeItems: "center" }}><Icon name="video" size={32} /></div>
            <h3>No projects yet</h3>
            <p>Start creating your first project. Import media, edit, and export your videos. All privately.</p>
            <Button size="lg" onClick={() => void create()}><Icon name="plus" />Create your first project</Button>
          </div>
        ) : noResults ? (
          <div className="empty" style={{ minHeight: "50vh" }}>
            <Icon name="search" />
            <h3>No results found</h3>
            <p>Your search for &quot;{query}&quot; did not return any results.</p>
            <Button variant="outline" size="lg" onClick={() => setQuery("")}>Clear search</Button>
          </div>
        ) : prefs.mode === "grid" ? (
          <div className="project-grid">
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} mode="grid" selected={selected.includes(p.id)} onOpen={() => navigate(`/editor/${p.id}`)}
                onToggle={(shift) => toggle(p.id, shift)} onMenu={(x, y) => setMenu({ state: { x, y }, project: p })} />
            ))}
          </div>
        ) : (
          <div>{visible.map((p) => (
            <ProjectCard key={p.id} project={p} mode="list" selected={selected.includes(p.id)} onOpen={() => navigate(`/editor/${p.id}`)}
              onToggle={(shift) => toggle(p.id, shift)} onMenu={(x, y) => setMenu({ state: { x, y }, project: p })} />
          ))}</div>
        )}
      </main>
      <ContextMenu state={menu?.state ?? null} entries={menu ? menuEntries(menu.project) : []} onClose={() => setMenu(null)} width={192} />
      <Dialog open={dialog?.kind === "rename"} onClose={() => setDialog(null)} title="Rename project"
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={() => { const p = dialog?.projects[0]; setDialog(null); if (p) void rename(p); }}>Rename</Button></>}>
        <label className="label" htmlFor="rename-input">New name</label>
        <input id="rename-input" data-autofocus className="input" placeholder="Enter a new name" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { const p = dialog?.projects[0]; setDialog(null); if (p) void rename(p); } }} />
      </Dialog>
      <Dialog open={dialog?.kind === "delete"} onClose={() => setDialog(null)}
        title={dialog?.projects.length === 1 ? `Delete '${dialog.projects[0]?.name}'?` : `Delete ${dialog?.projects.length ?? 0} projects?`}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button variant="destructive" onClick={() => { const list = dialog?.projects ?? []; setDialog(null); void remove(list); }}>Delete project</Button></>}>
        <div className="alert alert--destructive" role="alert"><div><strong>Warning</strong><br />This will permanently delete the project and all associated media from this browser.</div></div>
      </Dialog>
      <Dialog open={discarding !== null} onClose={() => setDiscarding(null)} title={`Delete '${discarding?.name ?? discarding?.id ?? ""}'?`}
        footer={<><Button variant="outline" onClick={() => setDiscarding(null)}>Cancel</Button><Button variant="destructive" onClick={() => { const p = discarding; setDiscarding(null); if (p) void discard(p); }}>Delete project</Button></>}>
        <div className="alert alert--destructive" role="alert"><div><strong>Warning</strong><br />This permanently deletes the unreadable project and its media from this browser. Export the raw data first if you may want it.</div></div>
      </Dialog>
      <Dialog open={dialog?.kind === "export"} onClose={() => setDialog(null)} title={`Export '${dialog?.projects[0]?.name ?? ""}'`}
        footer={<><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button onClick={() => { const p = dialog?.projects[0]; setDialog(null); if (p) void exportProject(p); }}>Export</Button></>}>
        <p>Saves the project, its media and its analysis as one {BUNDLE_EXTENSION} file you can import again, here or in another browser.</p>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" className="checkbox" checked={includeEmbeddings} onChange={(e) => setIncludeEmbeddings(e.target.checked)} />
          Include the visual search index (larger file)
        </label>
      </Dialog>
      <Dialog open={busy !== null} onClose={() => undefined} title={busy?.kind === "import" ? "Importing project" : "Exporting project"}>
        <div role="status" aria-live="polite">
          <progress style={{ width: "100%" }} {...(busy?.fraction != null ? { value: busy.fraction, max: 1 } : {})} aria-label="Progress" />
          <p className="muted truncate">{busy?.label}</p>
        </div>
      </Dialog>
      <Dialog open={dialog?.kind === "info"} onClose={() => setDialog(null)} title={dialog?.projects[0]?.name ?? "Project"}
        footer={<Button variant="outline" onClick={() => setDialog(null)}>Close</Button>}>
        {dialog?.projects[0] ? (
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 16px" }}>
            <dt className="muted">Duration</dt><dd style={{ margin: 0, textAlign: "right" }}>{formatDuration(dialog.projects[0].duration)}</dd>
            <dt className="muted">Created</dt><dd style={{ margin: 0, textAlign: "right" }}>{dateFormat.format(new Date(dialog.projects[0].createdAt))}</dd>
            <dt className="muted">Modified</dt><dd style={{ margin: 0, textAlign: "right" }}>{dateFormat.format(new Date(dialog.projects[0].updatedAt))}</dd>
            <dt className="muted">Project ID</dt><dd style={{ margin: 0, textAlign: "right" }}><code>{dialog.projects[0].id}</code></dd>
          </dl>
        ) : null}
      </Dialog>
    </div>
  );
}
