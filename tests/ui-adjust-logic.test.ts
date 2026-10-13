import { describe, expect, it } from "vitest";
import { insertElement } from "#/engine/commands";
import { FILTER_PRESET_IDS } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { ADJUST_DEFS, NEUTRAL_ADJUST, adjustCommand, adjustEffectOf, clearAdjustCommand, matchPreset, scaledPreset, swatchLook } from "../src/ui/properties/adjust-logic";
import { setupAgent } from "./agent-harness";
import { makeEditor, video } from "./helpers";

function clipEditor() {
  const { editor } = makeEditor();
  editor.execute(insertElement({ element: video("a", 0, 4), placement: { mode: "explicit", trackId: editor.tracks().main.id } }));
  const ref = { trackId: editor.tracks().main.id, elementId: "a" };
  const element = () => allElements(editor.tracks()).find((l) => l.element.id === "a")!.element;
  return { editor, ref, element };
}

describe("matchPreset", () => {
  it("treats an absent or neutral adjust as none", () => {
    expect(matchPreset(undefined)).toEqual({ kind: "none" });
    expect(matchPreset(NEUTRAL_ADJUST)).toEqual({ kind: "none" });
  });
  it("recognises every preset at full strength and at partial strength", () => {
    for (const id of FILTER_PRESET_IDS) {
      expect(matchPreset(scaledPreset(id, 1))).toEqual({ kind: "preset", id, intensity: 1 });
      const half = matchPreset(scaledPreset(id, 0.5));
      expect(half).toMatchObject({ kind: "preset", id });
      expect((half as { intensity: number }).intensity).toBeCloseTo(0.5, 1);
    }
  });
  it("reports a preset with a moved slider as custom", () => {
    expect(matchPreset({ ...scaledPreset("warm", 1), vignette: 20 })).toEqual({ kind: "custom" });
    expect(matchPreset({ brightness: 7 })).toEqual({ kind: "custom" });
  });
});

describe("scaledPreset", () => {
  it("matches what the apply_filter agent tool writes", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1", start: 0 });
    const tl = await h.data<{ tracks: Array<{ elements: Array<{ id: string }> }> }>("get_timeline");
    const id = tl.tracks.flatMap((t) => t.elements)[0]!.id;
    for (const filter of FILTER_PRESET_IDS) {
      await h.data("apply_filter", { elementIds: [id], filter, intensity: 0.6 });
      const params = adjustEffectOf(allElements(h.editor.tracks()).find((l) => l.element.id === id)!.element)!.params;
      for (const def of ADJUST_DEFS) expect(params[def.key], `${filter}.${def.key}`).toBe(scaledPreset(filter, 0.6)[def.key] ?? 0);
    }
  });
  it("never yields negative zero", () => {
    expect(Object.values(scaledPreset("mono", 0.01)).some((v) => Object.is(v, -0))).toBe(false);
  });
});

describe("adjustCommand", () => {
  it("creates one adjust effect on first use and edits it afterwards, one undo step each", () => {
    const { editor, ref, element } = clipEditor();
    editor.execute(adjustCommand({ element: element(), ref, values: { brightness: 30 }, reset: false, effectId: "fx1", label: "Adjust brightness" }));
    expect(adjustEffectOf(element())).toMatchObject({ id: "fx1", params: { brightness: 30, contrast: 0 } });
    editor.execute(adjustCommand({ element: element(), ref, values: { contrast: -20 }, reset: false, effectId: "fx2", label: "Adjust contrast" }));
    expect((element() as { effects: unknown[] }).effects).toHaveLength(1);
    expect(adjustEffectOf(element())!.params).toMatchObject({ brightness: 30, contrast: -20 });
    editor.undo();
    expect(adjustEffectOf(element())!.params).toMatchObject({ brightness: 30, contrast: 0 });
    editor.undo();
    expect(adjustEffectOf(element())).toBeUndefined();
  });
  it("a preview followed by the commit is the same single undo step", () => {
    const { editor, ref, element } = clipEditor();
    const cmd = (v: number) => adjustCommand({ element: element(), ref, values: scaledPreset("warm", v), reset: true, effectId: "fx", label: "Filter intensity" });
    expect(editor.preview(cmd(0.3))).toBe(true);
    expect(editor.preview(cmd(0.8))).toBe(true);
    editor.execute(cmd(0.9));
    expect(adjustEffectOf(element())!.params.temperature).toBe(Math.round(45 * 0.9));
    editor.undo();
    expect(adjustEffectOf(element())).toBeUndefined();
  });
  it("reset zeroes keys left out; a preset replaces an earlier look", () => {
    const { editor, ref, element } = clipEditor();
    editor.execute(adjustCommand({ element: element(), ref, values: { vignette: 50, sharpen: 10 }, reset: false, effectId: "fx", label: "x" }));
    editor.execute(adjustCommand({ element: element(), ref, values: scaledPreset("mono", 1), reset: true, effectId: "fx", label: "x" }));
    expect(matchPreset(adjustEffectOf(element())!.params)).toEqual({ kind: "preset", id: "mono", intensity: 1 });
  });
  it("clearAdjustCommand removes the effect, and is null when there is none", () => {
    const { editor, ref, element } = clipEditor();
    expect(clearAdjustCommand({ element: element(), ref })).toBeNull();
    editor.execute(adjustCommand({ element: element(), ref, values: { tint: 10 }, reset: false, effectId: "fx", label: "x" }));
    editor.execute(clearAdjustCommand({ element: element(), ref })!);
    expect(adjustEffectOf(element())).toBeUndefined();
  });
});

describe("swatchLook", () => {
  it("is neutral for none and follows the compositor plan for a look", () => {
    expect(swatchLook(NEUTRAL_ADJUST)).toEqual({ filter: "none", cast: "none", vignette: "none" });
    const noir = swatchLook(scaledPreset("noir", 1));
    expect(noir.filter).toContain("saturate(0)");
    expect(noir.vignette).toContain("radial-gradient");
    expect(swatchLook(scaledPreset("warm", 1)).cast).toContain("rgba(255,140,30");
  });
});
