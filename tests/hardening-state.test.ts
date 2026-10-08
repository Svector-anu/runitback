import { describe, expect, it, vi } from "vitest";
import { parseSubtitleFile } from "#/engine/captions";
import {
  addClipEffect, addMask, insertElement, insertElementsOnLanes, updateClipEffectParams, updateElements, updateMaskParams,
  upsertKeyframeCommand, currentScene,
} from "#/engine/commands";
import { runAction } from "#/engine/editor";
import {
  buildEffectElement, buildGraphicElement, buildTextElement, createProject, PARAM, sequentialIds, type Project, type TextElement, type TimelineElement,
} from "#/engine/model";
import { allElements, documentViolations } from "#/engine/timeline";
import { deserializeProject, serializeProject, repairProject } from "#/engine/persistence";
import { mediaTime } from "#/engine/time";
import { exportFileName } from "#/export/plan";
import { buildCaptionElement } from "#/render/caption-elements";
import { image, makeEditor, sec, text, video } from "./helpers";

const measure = (line: string): number => line.length * 10;

function onlyTrack(editor: ReturnType<typeof makeEditor>["editor"]) {
  return currentScene(editor.getState().doc).tracks;
}

describe("P1-4 view state is not a document commit", () => {
  it("setViewState fires onViewChanged but never onCommitted, and does not bump the revision", () => {
    const { editor } = makeEditor();
    const committed = vi.fn();
    const viewed = vi.fn();
    editor.onCommitted(committed);
    editor.onViewChanged(viewed);
    const revision = editor.getState().revision;
    editor.setViewState({ scrollLeft: 300 });
    editor.setViewState({ zoomLevel: 2 });
    expect(committed).not.toHaveBeenCalled();
    expect(viewed).toHaveBeenCalledTimes(2);
    expect(editor.getState().revision).toBe(revision);
    expect(editor.toProject().timelineViewState).toMatchObject({ scrollLeft: 300, zoomLevel: 2 });
  });
});

describe("P1-15 parameter bounds", () => {
  function withText() {
    const ctx = makeEditor();
    const el = text("t1", 0, 3);
    expect(ctx.editor.tryExecute(insertElement({ element: el, placement: { mode: "auto" } })).ok).toBe(true);
    const ref = allElements(onlyTrack(ctx.editor))[0]!.ref;
    return { ...ctx, ref };
  }
  const paramsOf = (editor: ReturnType<typeof makeEditor>["editor"], id: string) =>
    allElements(onlyTrack(editor)).find((l) => l.element.id === id)!.element.params;

  it("clamps fontSize 1e9 and other text params to their limits", () => {
    const { editor, ref } = withText();
    editor.execute(updateElements([{ ref, patch: { params: { [PARAM.fontSize]: 1e9, [PARAM.letterSpacing]: -1e9, [PARAM.bgPaddingX]: 1e12, [PARAM.positionX]: 1e15 } } }]));
    expect(paramsOf(editor, "t1")).toMatchObject({
      [PARAM.fontSize]: 500, [PARAM.letterSpacing]: -100, [PARAM.bgPaddingX]: 10_000, [PARAM.positionX]: 100_000,
    });
  });

  it("clamps blur intensity 1e9 on a clip effect and on a scene effect element", () => {
    const { editor, ref } = withText();
    editor.execute(addClipEffect({ ref, effectType: "blur", effectId: "fx1" }));
    editor.execute(updateClipEffectParams(ref, "fx1", { intensity: 1e9 }));
    const effects = (allElements(onlyTrack(editor))[0]!.element as TextElement).effects ?? [];
    expect(effects[0]?.params.intensity).toBe(100);

    const fx = buildEffectElement({ id: "fxel", startTime: sec(0), effectType: "blur", params: { intensity: 1e9 }, name: "Blur" });
    editor.execute(insertElement({ element: fx, placement: { mode: "auto" } }));
    expect(paramsOf(editor, "fxel").intensity).toBe(100);
  });

  it("clamps graphic params from their definition (corner radius, polygon sides) and mask params", () => {
    const { editor } = makeEditor();
    const g = buildGraphicElement({ id: "g1", startTime: sec(0), definitionId: "polygon", name: "Polygon" });
    editor.execute(insertElement({ element: g, placement: { mode: "auto" } }));
    const ref = allElements(onlyTrack(editor))[0]!.ref;
    editor.execute(updateElements([{ ref, patch: { params: { sides: 1e9, cornerRadius: -5, strokeWidth: 1e9 } } }]));
    expect(paramsOf(editor, "g1")).toMatchObject({ sides: 12, cornerRadius: 0, strokeWidth: 64 });

    editor.execute(addMask(ref, "rectangle"));
    const mask = (allElements(onlyTrack(editor))[0]!.element as unknown as { masks: Array<{ id: string }> }).masks[0]!;
    editor.execute(updateMaskParams(ref, mask.id, { feather: 1e9, width: 1e9 }));
    const params = (allElements(onlyTrack(editor))[0]!.element as unknown as { masks: Array<{ params: Record<string, number> }> }).masks[0]!.params;
    expect(params).toMatchObject({ feather: 1000, width: 4 });
  });

  it("clamps keyframe values and inserted elements, and rejects non-finite values", () => {
    const { editor, ref } = withText();
    editor.execute(upsertKeyframeCommand({ ref, path: PARAM.fontSize, time: 0, value: 1e9 }));
    const kf = JSON.stringify(allElements(onlyTrack(editor))[0]!.element.animations);
    expect(kf).toContain("500");
    expect(kf).not.toContain("1000000000");
    const bad = buildTextElement({ id: "t2", startTime: sec(10) });
    const huge: TimelineElement = { ...bad, params: { ...bad.params, [PARAM.fontSize]: 1e9 } };
    editor.execute(insertElement({ element: huge, placement: { mode: "auto" } }));
    expect(paramsOf(editor, "t2")[PARAM.fontSize]).toBe(500);
    const nan = editor.tryExecute(updateElements([{ ref, patch: { params: { [PARAM.fontSize]: Number.NaN } } }]));
    expect(nan.ok).toBe(false);
  });

  it("replaces an unsafe font family with the default instead of storing it", () => {
    const { editor, ref } = withText();
    editor.execute(updateElements([{ ref, patch: { params: { [PARAM.fontFamily]: 'x"; evil' } } }]));
    expect(paramsOf(editor, "t1")[PARAM.fontFamily]).toBe("Arial");
    editor.execute(updateElements([{ ref, patch: { params: { [PARAM.fontFamily]: "Open Sans" } } }]));
    expect(paramsOf(editor, "t1")[PARAM.fontFamily]).toBe("Open Sans");
  });
});

describe("caption import lands overlapping cues on separate tracks (b)", () => {
  const SRT = [
    "1\n00:00:00,000 --> 00:00:04,000\nfirst", "2\n00:00:02,000 --> 00:00:06,000\noverlaps first", "3\n00:00:03,000 --> 00:00:05,000\noverlaps both",
    "4\n00:00:07,000 --> 00:00:08,000\nalone",
  ].join("\n\n");

  it("one command, one undo step, no overlap on any track", () => {
    const { editor } = makeEditor();
    const parsed = parseSubtitleFile({ name: "a.srt", text: SRT });
    const canvas = editor.getState().doc.settings.canvasSize;
    const elements = parsed.cues.map((cue, i) => buildCaptionElement({ cue, index: i, id: editor.newId(), canvas, measure }));
    const before = editor.getState().canUndo;
    expect(editor.tryExecute(insertElementsOnLanes({ elements, index: 0, label: "Import captions" })).ok).toBe(true);
    const tracks = onlyTrack(editor);
    const textTracks = tracks.overlay.filter((t) => t.type === "text");
    expect(textTracks).toHaveLength(3);
    expect(textTracks.flatMap((t) => t.elements)).toHaveLength(4);
    expect(documentViolations(editor.getState().doc)).toEqual([]);
    editor.undo();
    expect(onlyTrack(editor).overlay).toHaveLength(0);
    expect(editor.getState().canUndo).toBe(before);
  });

  it("inserts 3 000 overlap-heavy cues in one command quickly (no per-cue copies)", () => {
    const { editor } = makeEditor();
    const lines = Array.from({ length: 20_000 }, (_, i) => `${i + 1}\n00:00:${String(Math.floor(i / 1000) % 60).padStart(2, "0")},${String((i % 1000)).padStart(3, "0")} --> 00:00:59,999\ncue ${i}`);
    const parsed = parseSubtitleFile({ name: "big.srt", text: lines.join("\n\n") });
    const canvas = editor.getState().doc.settings.canvasSize;
    const elements = parsed.cues.map((cue, i) => buildCaptionElement({ cue, index: i, id: `c${i}`, canvas, measure }));
    const started = performance.now();
    const ok = editor.tryExecute(insertElementsOnLanes({ elements: elements.slice(0, 3000), index: 0 })).ok;
    expect(ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(4000);
  });
});

describe("P1-14 damaged projects still open and are repaired (c)", () => {
  const base = (): Project => {
    const p = createProject({ id: "p", name: "Damaged", ids: sequentialIds("p"), now: "2026-01-01T00:00:00.000Z" });
    return p;
  };
  const roundTrip = (mutate: (p: Record<string, unknown>) => void): Project => {
    const raw = JSON.parse(serializeProject(base())) as Record<string, unknown>;
    mutate(raw);
    return deserializeProject(raw);
  };
  const mainElements = (raw: Record<string, unknown>): unknown[] => {
    const scene = (raw.scenes as Array<{ tracks: { main: { elements: unknown[] } } }>)[0]!;
    return scene.tracks.main.elements;
  };
  const textTrackElements = (raw: Record<string, unknown>): unknown[] => {
    const scene = (raw.scenes as Array<{ tracks: { overlay: unknown[] } }>)[0]!;
    const elements: unknown[] = [];
    scene.tracks.overlay.push({ id: "txt", name: "Text", type: "text", elements, hidden: false });
    return elements;
  };

  it("an undamaged project reports nothing", () => {
    const loaded = deserializeProject(serializeProject(base()));
    expect(loaded.repairNotes).toBeUndefined();
  });

  it("clamps a negative start, drops null (NaN) params, rounds fractional ticks", () => {
    const loaded = roundTrip((raw) => {
      const el = { ...text("t1", 0, 2), startTime: -500, params: { ...text("t1", 0, 2).params, [PARAM.positionX]: null, [PARAM.fontSize]: 1e9 } } as Record<string, unknown>;
      el.duration = 100.4;
      textTrackElements(raw).push(el);
    });
    const scene = loaded.scenes[0]!;
    const all = allElements(scene.tracks).map((l) => l.element);
    expect(all).toHaveLength(1);
    const el = all[0]!;
    expect(el.startTime).toBe(0);
    expect(el.duration).toBe(100);
    expect(el.params[PARAM.positionX]).toBeUndefined();
    expect(el.params[PARAM.fontSize]).toBe(500);
    expect(loaded.repairNotes!.length).toBeGreaterThanOrEqual(4);
    expect(documentViolations(loaded)).toEqual([]);
  });

  it("regenerates duplicated element and track ids", () => {
    const loaded = roundTrip((raw) => {
      mainElements(raw).push(video("same", 0, 2), video("same", 5, 2));
      const scene = (raw.scenes as Array<{ tracks: { overlay: unknown[] } }>)[0]!;
      scene.tracks.overlay.push({ id: "dup", name: "A", type: "text", elements: [], hidden: false }, { id: "dup", name: "B", type: "text", elements: [], hidden: false });
    });
    const scene = loaded.scenes[0]!;
    const tracks = [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio];
    const elementIds = tracks.flatMap((t) => t.elements.map((e) => e.id));
    expect(new Set(elementIds).size).toBe(elementIds.length);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(tracks.length);
    expect(loaded.repairNotes!.some((n) => /duplicated clip id/.test(n))).toBe(true);
    expect(documentViolations(loaded)).toEqual([]);
  });

  it("splits overlapping clips onto new tracks without losing any", () => {
    const loaded = roundTrip((raw) => {
      mainElements(raw).push(video("a", 0, 5), video("b", 2, 5), video("c", 3, 1));
    });
    const scene = loaded.scenes[0]!;
    const clips = allElements(scene.tracks).map((l) => l.element);
    expect(clips.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(scene.tracks.overlay.length).toBeGreaterThanOrEqual(2);
    expect(documentViolations(loaded)).toEqual([]);
    expect(loaded.repairNotes!.filter((n) => /moved to a new track/.test(n))).toHaveLength(2);
  });

  it("drops unreadable clips and fixes a bad frame rate and canvas, and still opens", () => {
    const loaded = roundTrip((raw) => {
      mainElements(raw).push(null, { id: "x", type: "wat" }, { ...video("n", 0, 1), duration: null }, video("keep", 0, 1));
      const settings = raw.settings as { fps: unknown; canvasSize: unknown };
      settings.fps = { numerator: 1000, denominator: 1 };
      settings.canvasSize = { width: 100000, height: 100000 };
    });
    expect(loaded.scenes[0]!.tracks.main.elements.map((e) => e.id)).toEqual(["keep"]);
    expect(loaded.settings.fps).toEqual({ numerator: 30, denominator: 1 });
    expect(loaded.settings.canvasSize).toEqual({ width: 1920, height: 1080 });
  });

  it("a non-array element list is reset instead of crashing the editor", () => {
    const loaded = roundTrip((raw) => {
      (raw.scenes as Array<{ tracks: { main: { elements: unknown } } }>)[0]!.tracks.main.elements = { oops: true };
    });
    expect(loaded.scenes[0]!.tracks.main.elements).toEqual([]);
    expect(loaded.repairNotes).toBeDefined();
  });

  it("an opened repaired project is editable and never persists the transient notes", () => {
    const loaded = roundTrip((raw) => { mainElements(raw).push({ ...video("a", 0, 2), startTime: -1 }); });
    const { editor } = makeEditor();
    editor.load({ project: loaded, assets: [] });
    expect(editor.duration()).toBeGreaterThan(0);
    expect(serializeProject(loaded)).not.toContain("repairNotes");
    expect(editor.toProject().repairNotes).toBeUndefined();
  });

  it("repairProject is idempotent", () => {
    const loaded = roundTrip((raw) => { mainElements(raw).push(video("a", 0, 5), video("b", 2, 5)); });
    expect(repairProject(loaded).repairs).toEqual([]);
  });

  it("fuzz: mutated JSON either throws ProjectFormatError or yields a project the editor can load", () => {
    let seed = 7;
    const rand = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const junk: unknown[] = [null, "x", -1, 1e300, Number.NaN, [], {}, true, 0.5];
    const original = JSON.parse(serializeProject((() => {
      const p = base();
      p.scenes[0]!.tracks.main.elements.push(video("a", 0, 2));
      p.scenes[0]!.tracks.overlay.push({ ...p.scenes[0]!.tracks.main, id: "o1", type: "text", elements: [text("t", 1, 2)] } as never);
      return p;
    })())) as unknown;
    const mutate = (node: unknown, depth: number): void => {
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (rand() < 0.04) record[key] = junk[Math.floor(rand() * junk.length)];
        else if (depth < 12) mutate(record[key], depth + 1);
      }
    };
    for (let i = 0; i < 300; i++) {
      const copy = JSON.parse(JSON.stringify(original)) as unknown;
      mutate(copy, 0);
      let project: Project;
      try {
        project = deserializeProject(copy);
      } catch (error) {
        expect((error as Error).name).toBe("ProjectFormatError");
        continue;
      }
      const { editor } = makeEditor();
      editor.load({ project, assets: [] });
      expect(() => editor.duration()).not.toThrow();
      expect(documentViolations(editor.getState().doc).filter((v) => !/source length/.test(v))).toEqual([]);
    }
  });
});

describe("UI-facing rejections are values, not exceptions (a)", () => {
  it("runAction reports a refused edit through onRejected and leaves the document alone", () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: image("i1", 0, 3), placement: { mode: "auto" } }));
    const ref = allElements(onlyTrack(editor))[0]!.ref;
    editor.setSelection({ elements: [ref], keyframes: [], keyframeAnchor: null });
    editor.playback.seek(mediaTime(sec(1)), 0);
    const before = editor.getState().doc;
    const rejected = vi.fn();
    const failing = vi.spyOn(editor, "tryExecute").mockReturnValue({ ok: false, error: new (class extends Error {})("nope") as never });
    expect(runAction(editor, "delete-selected", { nowMs: () => 0, onRejected: rejected })).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);
    failing.mockRestore();
    expect(editor.getState().doc).toBe(before);
  });

  it("tryCommitPreview returns the rejection when the plan went stale, and null when there is nothing to commit", () => {
    const { editor } = makeEditor();
    expect(editor.tryCommitPreview()).toBeNull();
    editor.execute(insertElement({ element: image("i1", 0, 3), placement: { mode: "auto" } }));
    const ref = allElements(onlyTrack(editor))[0]!.ref;
    expect(editor.preview(updateElements([{ ref, patch: { params: { opacity: 0.5 } } }]))).toBe(true);
    const outcome = editor.tryCommitPreview();
    expect(outcome?.ok).toBe(true);
    expect(editor.getState().preview).toBeNull();
  });
});

describe("P2 small fixes", () => {
  it("exportFileName strips control characters, trailing dots and reserved device names", () => {
    expect(exportFileName("a\u0000b\nc", "mp4")).toBe("abc.mp4");
    expect(exportFileName("movie...", "mp4")).toBe("movie.mp4");
    expect(exportFileName("CON", "mp4")).toBe("export.mp4");
    expect(exportFileName("my/project: v2", "webm")).toBe("my-project- v2.webm");
    expect(exportFileName("   ", "mp4")).toBe("export.mp4");
  });
});
