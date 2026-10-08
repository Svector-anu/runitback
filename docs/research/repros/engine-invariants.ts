// Run: pnpm exec tsx docs/research/repros/engine-invariants.ts
import { makeEditor, video, sec, tracksWith } from "../../../tests/helpers";
import { insertElement, updateElements, splitCommand, deleteElements, setElementParams, removeAssetsCommand } from "#/engine/commands";
import { allElements } from "#/engine/timeline";
import { mediaTime } from "#/engine/time";
import { buildMediaElement, type MediaAssetInfo } from "#/engine/model";
import { serializeProject, deserializeProject } from "#/engine/persistence";
import type { Editor } from "#/engine/editor";

const results: string[] = [];
const report = (id: string, reproduced: boolean, detail: string): void => { results.push(`${reproduced ? "REPRODUCED" : "not reproduced"} ${id}: ${detail}`); };

function overlaps(editor: Editor): string[] {
  const out: string[] = [];
  const t = editor.tracks();
  for (const track of [...t.overlay, t.main, ...t.audio]) {
    const els = [...track.elements].sort((a, b) => a.startTime - b.startTime);
    for (let i = 1; i < els.length; i++) if ((els[i - 1]!.startTime + els[i - 1]!.duration) > els[i]!.startTime) out.push(`${track.id}:${els[i - 1]!.id}/${els[i]!.id}`);
  }
  return out;
}
function seed(): { editor: Editor; mainId: string } {
  const { editor } = makeEditor();
  const mainId = editor.tracks().main.id;
  editor.execute(insertElement({ element: video("a", 0, 5), placement: { mode: "explicit", trackId: mainId } }));
  return { editor, mainId };
}

// E1: explicit insert onto a track ignores overlap
{
  const { editor, mainId } = seed();
  editor.execute(insertElement({ element: video("b", 2, 5), placement: { mode: "explicit", trackId: mainId } }));
  report("E1 insertElement explicit overlap", overlaps(editor).length > 0, JSON.stringify(overlaps(editor)));
}
// E2: updateElements startTime overlapping neighbour (non-main track)
{
  const { editor, mainId } = seed();
  editor.execute(insertElement({ element: video("b", 10, 5), placement: { mode: "explicit", trackId: mainId } }));
  editor.execute(updateElements([{ ref: { trackId: mainId, elementId: "b" }, patch: { startTime: sec(3) } }]));
  report("E2 updateElements startTime overlaps", overlaps(editor).length > 0, JSON.stringify(overlaps(editor)));
}
// E3: duration patch beyond source / negative / zero, no trim adjust
{
  const { editor, mainId } = seed();
  const ref = { trackId: mainId, elementId: "a" };
  editor.execute(updateElements([{ ref, patch: { duration: sec(500) } }]));
  const a = allElements(editor.tracks()).find((l) => l.element.id === "a")!.element;
  report("E3 duration patch breaks trim invariant", a.trimStart + a.duration + a.trimEnd !== a.sourceDuration, `dur=${a.duration} src=${a.sourceDuration}`);
  editor.execute(updateElements([{ ref, patch: { duration: -5 as never } }]));
  const a2 = allElements(editor.tracks()).find((l) => l.element.id === "a")!.element;
  report("E3b negative duration accepted", a2.duration < 0, `dur=${a2.duration}`);
  let threw = "";
  try { editor.execute(updateElements([{ ref, patch: { duration: NaN as never, startTime: Infinity as never } }])); } catch (e) { threw = String(e); }
  const a3 = allElements(editor.tracks()).find((l) => l.element.id === "a")!.element;
  report("E3c NaN/Infinity committed to doc even though execute threw (poisoned editor)", !Number.isFinite(a3.duration) || !Number.isFinite(a3.startTime), `threw=${threw}; doc dur=${a3.duration} start=${a3.startTime}; canUndo=${editor.getState().canUndo}`);
  let later = "";
  try { editor.duration(); } catch (e) { later = String(e); }
  report("E3c2 every later duration() read throws", later !== "", later);
  try { const json = serializeProject(editor.toProject()); const back = deserializeProject(json); const e = back.scenes[0]!.tracks.main.elements[0]!; report("E3d NaN->null on save", e.duration === null as never, `reloaded duration=${String(e.duration)}`); } catch (e) { report("E3d", true, `toProject/serialize threw ${String(e)}`); }
}
// E4: main-track pin to 0 overlaps first clip
{
  const { editor, mainId } = seed();
  editor.execute(insertElement({ element: video("b", 20, 30), placement: { mode: "explicit", trackId: mainId } }));
  editor.execute(updateElements([{ ref: { trackId: mainId, elementId: "b" }, patch: { startTime: sec(0) } }]));
  report("E4 main pin-to-0 overlap", overlaps(editor).length > 0, JSON.stringify(overlaps(editor)));
}
// E5: duplicate ids
{
  const { editor, mainId } = seed();
  editor.execute(insertElement({ element: video("a", 10, 2), placement: { mode: "explicit", trackId: mainId } }));
  const n = allElements(editor.tracks()).filter((l) => l.element.id === "a").length;
  report("E5 duplicate element id accepted", n > 1, `count=${n}`);
  editor.execute(deleteElements([{ trackId: mainId, elementId: "a" }]));
  report("E5b delete by dup id removes both", allElements(editor.tracks()).length === 0, `remaining=${allElements(editor.tracks()).length}`);
}
// E6: zero-duration element + split
{
  const { editor, mainId } = seed();
  editor.execute(insertElement({ element: { ...video("z", 10, 1), duration: mediaTime(0) }, placement: { mode: "explicit", trackId: mainId } }));
  report("E6 zero-duration clip accepted", allElements(editor.tracks()).some((l) => l.element.id === "z" && l.element.duration === 0), "ok");
}
// E7: undo drops assets registered after the snapshot
{
  const { editor, mainId } = seed();
  const asset: MediaAssetInfo = { id: "late", name: "late.mp4", type: "video", size: 1, lastModified: 0, width: 10, height: 10, duration: sec(2), hasAudio: false };
  editor.execute(setElementParams({ refs: [{ trackId: mainId, elementId: "a" }], params: { opacity: 0.5 } }));
  editor.registerAsset(asset);
  editor.execute(insertElement({ element: buildMediaElement({ id: "late-el", startTime: mediaTime(sec(100)), asset }), placement: { mode: "auto" } }));
  editor.undo(); editor.undo();
  const has = editor.getState().doc.assets.some((a) => a.id === "late");
  report("E7 undo removes registered asset from doc.assets (-> assetIds, orphan sweep)", !has, `assets after 2 undos=${editor.getState().doc.assets.map((a) => a.id)} toProject.assetIds=${JSON.stringify(editor.toProject().assetIds)}`);
}
// E7b: registerAsset between undo and redo is erased by redo (redo restores entry.after.assets)
{
  const { editor, mainId } = seed();
  const asset: MediaAssetInfo = { id: "late2", name: "late2.mp4", type: "video", size: 1, lastModified: 0, width: 10, height: 10, duration: sec(2), hasAudio: false };
  editor.execute(setElementParams({ refs: [{ trackId: mainId, elementId: "a" }], params: { opacity: 0.5 } }));
  editor.undo();
  editor.registerAsset(asset);
  editor.redo();
  report("E7b redo drops asset registered after the undo", !editor.getState().doc.assets.some((a) => a.id === "late2"), `assets=${JSON.stringify(editor.getState().doc.assets.map((a) => a.id))}`);
}
// E10: a drag plan computed before a concurrent edit throws inside the pointermove handler
{
  const { editor, mainId } = seed();
  const { buildMoveGroup, resolveGroupMove, mintTrackIds } = await import("#/engine/timeline");
  const { moveElements } = await import("#/engine/commands");
  const tracks = editor.tracks();
  const members = buildMoveGroup({ tracks, anchor: { trackId: mainId, elementId: "a" }, selection: [{ trackId: mainId, elementId: "a" }] })!;
  const plan = resolveGroupMove({ tracks, members, target: { trackIndex: 0, isNewTrack: true, insertPosition: null, xPosition: mediaTime(0), targetElement: null }, anchorStart: sec(3), newTrackIds: mintTrackIds(1, editor.newId) })!;
  editor.execute(deleteElements([{ trackId: mainId, elementId: "a" }])); // e.g. Delete key pressed mid-drag
  let threw = "";
  try { editor.preview(moveElements(plan)); } catch (e) { threw = String(e); }
  report("E10 stale drag plan throws from editor.preview (uncaught in pointermove)", threw !== "", threw);
}
// E8: remove asset then redo/undo ordering w/ load-time assets
{
  const { editor } = makeEditor();
  const bad = editor.getState().doc;
  report("E8 empty scene duration", editor.duration() === 0, String(editor.duration()));
  void bad; void splitCommand; void removeAssetsCommand; void tracksWith;
}
// E9: non-integer / NaN into commands that use mediaTime throws mid-execute (state unchanged?)
{
  const { editor, mainId } = seed();
  let threw = false;
  try { editor.execute(splitCommand({ refs: [{ trackId: mainId, elementId: "a" }], splitTime: sec(1) + 0.5 })); } catch { threw = true; }
  report("E9 split at fractional tick throws RangeError out of execute", threw, "uncaught exception reaches caller (agent bridge must catch)");
}
console.log(results.join("\n"));
