// Run: pnpm exec tsx docs/research/repros/persistence-races.ts
import { makeEditor, video } from "../../../tests/helpers";
import { insertElement } from "#/engine/commands";
import { SaveManager, deserializeProject, serializeProject, MemoryProjectRepository, ProjectsService, MemoryAssetRepository } from "#/engine/persistence";
import type { Project } from "#/engine/model";
import { sequentialIds } from "#/engine/model";
import { Editor } from "#/engine/editor";
import type { ProjectRepository } from "#/engine/persistence";

const out: string[] = [];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// S1: flush() returns immediately while a save is in flight; edits made after the in-flight snapshot are not flushed.
{
  const { editor, project } = makeEditor();
  const saved: number[] = [];
  const slow: ProjectRepository = {
    list: async () => [], load: async () => null, delete: async () => undefined,
    save: async (p: Project) => { await sleep(100); saved.push(p.scenes[0]!.tracks.main.elements.length + p.scenes[0]!.tracks.overlay.length); },
  };
  const sm = new SaveManager({ editor, repository: slow, debounceMs: 10 });
  sm.start();
  void project;
  editor.execute(insertElement({ element: video("a", 0, 1), placement: { mode: "auto" } }));
  await sleep(30); // autosave now in flight (100 ms write)
  editor.execute(insertElement({ element: video("b", 0, 1), placement: { mode: "auto" } }));
  const t0 = Date.now();
  await sm.flush(); // what closeProject() awaits before editor.close()
  const flushMs = Date.now() - t0;
  editor.close(); // closeProject proceeds
  await sleep(300);
  out.push(`S1 flush returned after ${flushMs} ms (write takes 100 ms); persisted element counts=${JSON.stringify(saved)}; second edit persisted? ${saved.some((n) => n >= 2)}  -> REPRODUCED if false`);
}
// S2: save failure + flush: flush resolves normally although nothing was persisted (closeProject then sweeps orphans using the unsaved in-memory project)
{
  const { editor } = makeEditor();
  const repo = new MemoryProjectRepository();
  repo.failNextSaves = 5;
  const sm = new SaveManager({ editor, repository: repo, debounceMs: 5, maxRetryMs: 50 });
  sm.start();
  editor.execute(insertElement({ element: video("a", 0, 1), placement: { mode: "auto" } }));
  let threw = false;
  try { await sm.flush(); } catch { threw = true; }
  out.push(`S2 flush() with failing storage: threw=${threw}, saveCount=${repo.saveCount}, state=${sm.getState().status} -> REPRODUCED if threw=false and saveCount=0 (caller cannot tell the save failed)`);
  sm.stop();
}
// S3: schema validation holes -> unopenable project
{
  const { project } = makeEditor();
  const bad: Project = JSON.parse(serializeProject(project)) as Project;
  (bad.scenes[0]!.tracks.main as unknown as { elements: unknown }).elements = [{ id: "x", type: "video", startTime: null, duration: null, trimStart: 0, trimEnd: 0, params: {}, mediaId: "m" }];
  let loadErr = "";
  try {
    const p = deserializeProject(JSON.stringify(bad)); // passes validateProject
    const e = new Editor({ newId: sequentialIds("z"), now: () => "t" });
    e.load({ project: p, assets: [] });
    const el = e.tracks().main.elements[0]!;
    loadErr = `no throw; element.duration=${String(el.duration)} startTime=${String(el.startTime)} editor.duration()=${e.duration()} (null leaks into engine arithmetic; NaN/Infinity round-trip as null through JSON)`;
  } catch (err) { loadErr = "threw " + String(err); }
  out.push(`S3 element with null startTime/duration passes validateProject: ${loadErr}`);
  const missing: Project = JSON.parse(serializeProject(project)) as Project;
  delete (missing.scenes[0]!.tracks.main as unknown as { elements?: unknown }).elements;
  let err2 = "";
  try { const p = deserializeProject(JSON.stringify(missing)); const e = new Editor({ newId: sequentialIds("z"), now: () => "t" }); e.load({ project: p, assets: [] }); e.duration(); } catch (e) { err2 = String(e); }
  out.push(`S3b main track without 'elements' passes validateProject; later throws: ${err2 || "(no throw)"}`);
}
// S4: toProject hard-codes version 1 and drops asset ids not in doc.assets (asset bytes then orphan-swept)
{
  const { editor } = makeEditor();
  const p = editor.toProject();
  out.push(`S4 toProject().version=${p.version} (PROJECT_SCHEMA_VERSION literal hard-coded in editor.ts:154)`);
}
// S5: duplicate() is not atomic: project saved before assets copied
{
  const projects = new MemoryProjectRepository();
  const assets = new MemoryAssetRepository();
  const failing = Object.assign(Object.create(assets) as MemoryAssetRepository, { copyAll: async () => { throw new Error("OPFS write failed"); } });
  const svc = new ProjectsService({ projects, assets: failing, newId: sequentialIds("p"), now: () => "t" });
  const created = await svc.create("A");
  let err = "";
  try { await svc.duplicate([created.metadata.id]); } catch (e) { err = String(e); }
  const list = await projects.list();
  out.push(`S5 duplicate failed (${err}) but project list now has ${list.length} entries (copy without media left behind)`);
}
console.log(out.join("\n"));
