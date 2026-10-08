// Run: pnpm exec tsx docs/research/repros/fuzz-ui-paths.ts [seed] [steps]
// Random walk over the operations the shipped UI can reach (insert-auto, move/drag plan, resize, split, speed, ripple,
// duplicate, paste, delete, undo/redo) and check engine invariants after each step.
import { makeEditor, videoAsset } from "../../../tests/helpers";
import {
  deleteElements, duplicateCommand, insertMediaElement, moveElements, pasteCommand, splitCommand, updateElements,
} from "#/engine/commands";
import {
  allElements, buildMoveGroup, buildResizeMembers, computeGroupResize, effectiveRate, mintTrackIds, resolveGroupMove, type DropTarget,
} from "#/engine/timeline";
import { mediaTime, TICKS_PER_SECOND } from "#/engine/time";
import { orderedTracks, type TimelineElement } from "#/engine/model";
import type { Editor } from "#/engine/editor";

let seed = Number(process.argv[2] ?? 1);
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
const steps = Number(process.argv[3] ?? 400);

function violations(editor: Editor): string[] {
  const v: string[] = [];
  const tracks = editor.tracks();
  const ids = new Set<string>();
  for (const track of orderedTracks(tracks)) {
    const els = [...(track.elements as TimelineElement[])].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < els.length; i++) {
      const e = els[i]!;
      if (ids.has(e.id)) v.push(`duplicate id ${e.id}`);
      ids.add(e.id);
      if (!Number.isInteger(e.startTime) || !Number.isInteger(e.duration)) v.push(`non-integer time on ${e.id}`);
      if (e.startTime < 0) v.push(`negative start ${e.id}=${e.startTime}`);
      if (e.duration <= 0) v.push(`non-positive duration ${e.id}=${e.duration}`);
      if (i > 0 && els[i - 1]!.startTime + els[i - 1]!.duration > e.startTime) v.push(`overlap on ${track.id}: ${els[i - 1]!.id}/${e.id}`);
      if ((e.type === "video" || e.type === "audio") && e.sourceDuration !== undefined) {
        const rate = effectiveRate(e.retime);
        const total = e.trimStart + e.duration * rate + e.trimEnd;
        if (Math.abs(total - e.sourceDuration) > 2 + rate) v.push(`trim invariant ${e.id}: ${total} vs ${e.sourceDuration}`);
      }
    }
  }
  return v;
}

const { editor } = makeEditor({ assets: [videoAsset("v1", 10), videoAsset("v2", 4)] });
const all = (): ReturnType<typeof allElements> => allElements(editor.tracks());
let n = 0;
const log: string[] = [];
function op(): string {
  const els = all();
  const sel = els.length ? [pick(els)] : [];
  switch (Math.floor(rnd() * 11)) {
    case 0: case 1: {
      const a = editor.getState().doc.assets[Math.floor(rnd() * 2)]!;
      editor.execute(insertMediaElement({ asset: a, elementId: editor.newId(), startTime: mediaTime(Math.floor(rnd() * 20) * TICKS_PER_SECOND / 2), placement: { mode: "auto" } }));
      return "insert-auto";
    }
    case 2: {
      if (!sel[0]) return "skip";
      const anchor = sel[0].ref;
      const tracks = editor.tracks();
      const members = buildMoveGroup({ tracks, anchor, selection: editor.getState().selection.elements.length ? editor.getState().selection.elements : [anchor] });
      if (!members) return "skip";
      const ordered = orderedTracks(tracks);
      const target: DropTarget = { trackIndex: Math.floor(rnd() * (ordered.length + 1)), isNewTrack: rnd() < 0.3, insertPosition: null, xPosition: mediaTime(0), targetElement: null };
      const plan = resolveGroupMove({ tracks, members, target, anchorStart: Math.floor(rnd() * 20 * TICKS_PER_SECOND / 4000) * 4000, newTrackIds: mintTrackIds(members.length, editor.newId) });
      if (!plan) return "move-revert";
      editor.execute(moveElements(plan));
      return "move";
    }
    case 3: case 4: {
      if (!sel[0]) return "skip";
      const members = buildResizeMembers({ tracks: editor.tracks(), refs: [sel[0].ref] });
      const side = rnd() < 0.5 ? "left" : "right";
      const r = computeGroupResize({ members, side, delta: Math.round((rnd() - 0.5) * 6 * TICKS_PER_SECOND), fps: editor.fps() });
      editor.execute(updateElements(r.patches, "Resize"));
      return `resize-${side}`;
    }
    case 5: {
      if (!sel[0]) return "skip";
      editor.execute(splitCommand({ refs: [sel[0].ref], splitTime: sel[0].element.startTime + Math.floor(rnd() * sel[0].element.duration / 4000) * 4000 }));
      return "split";
    }
    case 6: {
      if (!sel[0] || sel[0].element.type !== "video") return "skip";
      editor.execute(updateElements([{ ref: sel[0].ref, patch: { retime: { rate: pick([0.5, 0.75, 1.5, 2, 3.7]), maintainPitch: false } } as never }], "Speed"));
      return "speed";
    }
    case 7: { editor.setRippleEnabled(!editor.getState().rippleEnabled); return "ripple-toggle"; }
    case 8: {
      if (!sel[0]) return "skip";
      if (rnd() < 0.5) editor.execute(duplicateCommand([sel[0].ref]));
      else { editor.setSelection({ elements: [sel[0].ref], keyframes: [], keyframeAnchor: null }); editor.copySelection(); editor.execute(pasteCommand({ items: editor.clipboard!, time: Math.floor(rnd() * 10 * TICKS_PER_SECOND / 4000) * 4000 })); }
      return "dup/paste";
    }
    case 9: { if (!sel[0]) return "skip"; editor.execute(deleteElements([sel[0].ref])); return "delete"; }
    default: { if (rnd() < 0.5) editor.undo(); else editor.redo(); return "undo/redo"; }
  }
}
for (; n < steps; n++) {
  let name = "";
  try { name = op(); } catch (e) { log.push(`step ${n}: EXCEPTION ${String(e)}`); break; }
  const v = violations(editor);
  log.push(`${n} ${name}${editor.getState().rippleEnabled ? " (ripple)" : ""}`);
  if (v.length) { console.log(`seed-state violation after step ${n} (${name}, ripple=${editor.getState().rippleEnabled}):\n  ${v.join("\n  ")}\nlast ops:\n  ${log.slice(-6).join("\n  ")}`); process.exit(0); }
}
const hist: Record<string, number> = {};
for (const l of log) { const k = l.split(" ")[1] ?? "?"; hist[k] = (hist[k] ?? 0) + 1; }
console.log(`no violation in ${n} steps (seed arg ${process.argv[2] ?? 1}); elements=${all().length}; ops=${JSON.stringify(hist)}`);
