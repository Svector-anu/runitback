import { describe, expect, it } from "vitest";
import { currentScene } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import { PARAM, type SceneTracks, type TimelineElement } from "#/engine/model";
import { TICKS_PER_SECOND, frameRateFromFloat, frameDuration } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import {
  TemplateApplyError, applyTemplateToEditor, planTemplate, parseTemplate, type ProjectTemplate, type TemplateInputs,
} from "#/engine/templates";
import { getTemplate, listTemplates } from "#/templates";
import { checkInvariants, editorWith, assetOf, sampleTemplate, type AssetSpec } from "./template-support";

const tracksOf = (editor: Editor): SceneTracks => currentScene(editor.getState().doc).tracks;
const elementsOf = (editor: Editor): TimelineElement[] => allElements(tracksOf(editor)).map((l) => l.element);
const endOf = (editor: Editor): number => elementsOf(editor).reduce((m, e) => Math.max(m, e.startTime + e.duration), 0);
const sec = (ticks: number): number => ticks / TICKS_PER_SECOND;

/** Fills every slot of a template (and each repeat item) with generated assets of a fitting kind. */
function fillAll(template: ProjectTemplate, options: { seconds?: number; items?: number } = {}): { specs: AssetSpec[]; inputs: TemplateInputs } {
  const specs: AssetSpec[] = [];
  const slotsFor = (list: ProjectTemplate["slots"], prefix: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const slot of list) {
      const id = `${prefix}${slot.id}`;
      specs.push({ id, type: slot.kind, seconds: options.seconds ?? Math.max(slot.expectedSeconds ?? 8, 8) + 4 });
      out[slot.id] = id;
    }
    return out;
  };
  const inputs: TemplateInputs = { slots: slotsFor(template.slots, "") };
  if (template.repeat) {
    inputs.repeat = Object.fromEntries(template.repeat.map((g) => [
      g.id, Array.from({ length: options.items ?? g.min }, (_, i) => ({ slots: slotsFor(g.slots, `${g.id}-${i}-`) })),
    ]));
  }
  return { specs, inputs };
}

function sourceMappingHolds(editor: Editor): void {
  for (const element of elementsOf(editor)) {
    if (element.type === "video" || element.type === "audio") {
      expect(element.trimStart + element.duration + element.trimEnd, `${element.id} source mapping`).toBe(element.sourceDuration);
    }
  }
}

describe("applyTemplateToEditor on every shipped template", () => {
  for (const template of listTemplates()) {
    describe(template.id, () => {
      it("fills the timeline in one undo step with the declared canvas, frame rate and length", () => {
        const { specs, inputs } = fillAll(template);
        const editor = editorWith(specs);
        const before = editor.getState();
        const result = applyTemplateToEditor(editor, template, inputs, { requireAllSlots: true });
        const fps = frameRateToFloat(template.canvas.fps);
        const doc = editor.getState().doc;
        expect(doc.settings.fps.numerator / doc.settings.fps.denominator).toBeCloseTo(fps, 3);
        expect(doc.settings.canvasSize.width / doc.settings.canvasSize.height).toBeCloseTo(
          { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3 }[template.canvas.aspect], 3);
        expect(result.missingSlots).toEqual([]);
        expect(result.warnings.filter((w) => w.code !== "short-media"), JSON.stringify(result.warnings)).toEqual([]);
        expect(elementsOf(editor).length).toBe(result.elementIds.length);
        checkInvariants(editor);
        sourceMappingHolds(editor);
        const frame = frameDuration(frameRateFromFloat(template.canvas.fps));
        expect(Math.abs(endOf(editor) - Math.round(template.durationSeconds * TICKS_PER_SECOND))).toBeLessThanOrEqual(frame);

        expect(editor.undo()).toBe(true);
        expect(editor.getState().doc).toBe(before.doc);
        expect(editor.getState().canUndo).toBe(false);
        expect(editor.redo()).toBe(true);
        expect(elementsOf(editor).length).toBe(result.elementIds.length);
      });

      it("keeps the placeholder words when none are given and uses the user's words when given", () => {
        const { specs, inputs } = fillAll(template);
        const editor = editorWith(specs);
        applyTemplateToEditor(editor, template, inputs);
        const contents = elementsOf(editor).filter((e) => e.type === "text").map((e) => String(e.params[PARAM.content]));
        const first = template.texts[0];
        expect(first).toBeDefined();
        if (!first) return;
        expect(contents.some((c) => c.replace(/\n/g, " ") === first.default.replace(/\n/g, " "))).toBe(true);

        const custom = editorWith(specs);
        applyTemplateToEditor(custom, template, { ...inputs, texts: { [first.id]: "Zebra crossing" } });
        const customContents = elementsOf(custom).filter((e) => e.type === "text").map((e) => String(e.params[PARAM.content]).replace(/\n/g, " "));
        expect(customContents).toContain("Zebra crossing");
      });

      it("is deterministic", () => {
        const { specs, inputs } = fillAll(template);
        const a = editorWith(specs);
        const b = editorWith(specs);
        applyTemplateToEditor(a, template, inputs);
        applyTemplateToEditor(b, template, inputs);
        const strip = (_k: string, v: unknown): unknown => (_k === "id" ? undefined : v);
        expect(JSON.stringify(currentScene(a.getState().doc).tracks, strip)).toBe(JSON.stringify(currentScene(b.getState().doc).tracks, strip));
      });

      it("still builds a valid document with no media at all and names what is missing", () => {
        const editor = editorWith([]);
        const result = applyTemplateToEditor(editor, template, {});
        checkInvariants(editor);
        const required = [...template.slots, ...(template.repeat ?? []).flatMap((g) => g.slots)].filter((s) => !s.optional);
        if (required.length > 0) expect(result.warnings.some((w) => w.code === "missing-slot")).toBe(true);
        expect(editor.undo()).toBe(true);
        expect(editor.getState().canUndo).toBe(false);
      });

      it("survives 0.4 s clips in every slot under the default policy", () => {
        const { specs, inputs } = fillAll(template, { seconds: 0.4 });
        const editor = editorWith(specs);
        applyTemplateToEditor(editor, template, inputs);
        checkInvariants(editor);
        sourceMappingHolds(editor);
      });
    });
  }
});

function frameRateToFloat(fps: number): number {
  return fps;
}

describe("applyTemplateToEditor: product launch details", () => {
  const template = getTemplate("product-launch") as ProjectTemplate;

  it("lays recordings back to back on the main track with the declared transitions", () => {
    const { specs, inputs } = fillAll(template);
    const editor = editorWith(specs);
    applyTemplateToEditor(editor, template, inputs);
    const main = tracksOf(editor).main.elements;
    expect(main.map((e) => [e.type, sec(e.startTime), sec(e.duration)])).toEqual([
      ["video", 0, 4], ["video", 4, 6.5], ["video", 10.5, 6.5], ["video", 17, 4],
    ]);
    const types = main.map((e) => (e.type === "video" || e.type === "image" ? e.transition?.type : undefined));
    expect(types).toEqual([undefined, "dissolve", "wipe-left", "zoom"]);
    const result = main.find((e) => e.type === "video" && e.startTime === 17 * TICKS_PER_SECOND);
    expect(result?.type === "video" ? sec(result.trimStart) : -1).toBe(4);
  });

  it("styles text with the preset, stroke/shadow params and animations", () => {
    const { specs, inputs } = fillAll(template);
    const editor = editorWith(specs);
    applyTemplateToEditor(editor, template, inputs, { requireAllSlots: true });
    const headline = elementsOf(editor).find((e) => e.type === "text" && String(e.params[PARAM.content]).includes("faster"));
    expect(headline?.type).toBe("text");
    if (headline?.type !== "text") return;
    expect(headline.params[PARAM.shadowEnabled]).toBe(true);
    expect(headline.params[PARAM.fontWeight]).toBe("bold");
    expect(headline.textAnimation?.in?.preset).toBe("slide-up");
    expect(headline.textAnimation?.out?.preset).toBe("fade");
    expect(headline.animations).toBeDefined();
    const canvasHeight = editor.getState().doc.settings.canvasSize.height;
    expect((headline.params[PARAM.fontSize] as number) * (canvasHeight / 90)).toBeGreaterThan(100);
  });

  it("adds a rounded callout pill whose background is on", () => {
    const { specs, inputs } = fillAll(template);
    const editor = editorWith(specs);
    applyTemplateToEditor(editor, template, inputs);
    const pill = elementsOf(editor).find((e) => e.type === "text" && String(e.params[PARAM.content]).startsWith("Plan everything"));
    expect(pill?.params[PARAM.bgEnabled]).toBe(true);
  });
});

describe("applyTemplateToEditor: media handling", () => {
  const base = (): ProjectTemplate => sampleTemplate();
  const inputsFor = (overrides: TemplateInputs = {}): TemplateInputs => ({ slots: { "clip-a": "a", "clip-b": "b" }, ...overrides });

  it("trims long clips to the beat and keeps the rest as trimEnd", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 20 }, { id: "b", type: "video", seconds: 5 }]);
    const result = applyTemplateToEditor(editor, base(), inputsFor());
    const a = tracksOf(editor).main.elements[0];
    expect(a?.type === "video" && [sec(a.duration), sec(a.trimStart), sec(a.trimEnd)]).toEqual([5, 0, 15]);
    expect(result.warnings).toEqual([]);
    sourceMappingHolds(editor);
  });

  it("honours sourceStart but never reads past the end of the source", () => {
    const template = sampleTemplate({
      beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a", sourceStart: 12 } }, { id: "b", at: 5, duration: 5, media: { slot: "clip-b", sourceStart: 3 } }],
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 14 }, { id: "b", type: "video", seconds: 20 }]);
    applyTemplateToEditor(editor, template, inputsFor());
    const [a, b] = tracksOf(editor).main.elements;
    expect(a?.type === "video" && sec(a.trimStart)).toBe(9);
    expect(b?.type === "video" && sec(b.trimStart)).toBe(3);
    sourceMappingHolds(editor);
  });

  it("holds the last frame of a short clip as a freeze-frame image by default", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 2 }, { id: "b", type: "video", seconds: 5 }]);
    const result = applyTemplateToEditor(editor, base(), inputsFor());
    const main = tracksOf(editor).main.elements;
    expect(main.map((e) => [e.type, sec(e.startTime), sec(e.duration)])).toEqual([["video", 0, 2], ["image", 2, 3], ["video", 5, 5]]);
    const held = main[1];
    expect(held?.type === "image" && held.freezeAt !== undefined && held.mediaId === "a").toBe(true);
    expect(result.warnings.map((w) => w.code)).toEqual(["short-media"]);
    expect(result.warnings[0]?.message).toContain("last frame is held");
    checkInvariants(editor);
  });

  it("loops a short clip when the beat asks for it", () => {
    const template = sampleTemplate({
      beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a", onShort: "loop" } }, { id: "b", at: 5, duration: 5, media: { slot: "clip-b" } }],
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 2 }, { id: "b", type: "video", seconds: 5 }]);
    const result = applyTemplateToEditor(editor, template, inputsFor());
    const main = tracksOf(editor).main.elements;
    expect(main.map((e) => [e.type, sec(e.startTime), sec(e.duration)])).toEqual([["video", 0, 2], ["video", 2, 2], ["video", 4, 1], ["video", 5, 5]]);
    expect(result.warnings[0]?.message).toContain("loops");
    sourceMappingHolds(editor);
    checkInvariants(editor);
  });

  it("ends the beat early when the beat asks to shrink", () => {
    const template = sampleTemplate({
      beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a", onShort: "shrink" } }, { id: "b", at: 5, duration: 5, media: { slot: "clip-b" } }],
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 2 }, { id: "b", type: "video", seconds: 5 }]);
    applyTemplateToEditor(editor, template, inputsFor());
    expect(tracksOf(editor).main.elements.map((e) => [sec(e.startTime), sec(e.duration)])).toEqual([[0, 2], [5, 5]]);
    checkInvariants(editor);
  });

  it("falls back to loop-free hold when too many copies would be needed", () => {
    const template = sampleTemplate({
      beats: [{ id: "a", at: 0, duration: 60, media: { slot: "clip-a", onShort: "loop" } }],
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 1 }]);
    const result = applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" } });
    expect(result.warnings[0]?.message).toContain("held");
    expect(tracksOf(editor).main.elements).toHaveLength(2);
  });

  it("uses an image as a still for the whole beat and skips what is missing", () => {
    const editor = editorWith([{ id: "a", type: "image" }]);
    const result = applyTemplateToEditor(editor, base(), { slots: { "clip-a": "a" } });
    const main = tracksOf(editor).main.elements;
    expect(main).toHaveLength(1);
    expect(main[0]?.type).toBe("image");
    expect(sec(main[0]?.duration ?? 0)).toBe(5);
    expect(result.missingSlots).toEqual(["clip-b"]);
    expect(result.warnings.map((w) => w.code)).toContain("missing-slot");
    checkInvariants(editor);
  });

  it("demotes main-track beats to an overlay track when the first one does not start at 0", () => {
    const template = sampleTemplate({
      beats: [{ id: "a", at: 2, duration: 4, media: { slot: "clip-a" } }, { id: "b", at: 6, duration: 4, media: { slot: "clip-b", transitionIn: { type: "dissolve" } } }],
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }, { id: "b", type: "video", seconds: 8 }]);
    applyTemplateToEditor(editor, template, inputsFor());
    expect(tracksOf(editor).main.elements).toHaveLength(0);
    const overlay = tracksOf(editor).overlay[0];
    expect(overlay?.elements.map((e) => sec(e.startTime))).toEqual([2, 6]);
    checkInvariants(editor);
  });

  it("puts boxed overlay media above the main track and keeps the crop centred", () => {
    const template = sampleTemplate({
      slots: [{ id: "clip-a", kind: "video", label: "A" }],
      beats: [{ id: "a", at: 0, duration: 4, media: { slot: "clip-a", track: "overlay", box: { x: -500, y: 0, width: 600, height: 800 }, fit: "cover" } }],
      texts: [], 
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 8, width: 1920, height: 1080 }]);
    applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" } });
    const clip = tracksOf(editor).overlay[0]?.elements[0];
    expect(clip?.params[PARAM.positionX]).toBe(-500);
    const left = Number(clip?.params[PARAM.cropLeft]);
    const right = Number(clip?.params[PARAM.cropRight]);
    expect(left).toBeCloseTo(right, 3);
    expect(left).toBeGreaterThan(0.2);
  });

  it("runs a toEnd music bed to the last clip, whatever the media lengths are", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }, { id: "b", type: "video", seconds: 8 }, { id: "m", type: "audio", seconds: 60 }]);
    const template = sampleTemplate({
      beats: [
        { id: "a", at: 0, duration: 5, media: { slot: "clip-a" } }, { id: "b", at: 5, duration: 7.5, media: { slot: "clip-b" } },
        { id: "m", at: 0, duration: 1, toEnd: true, media: { slot: "music" } },
      ],
    });
    applyTemplateToEditor(editor, template, inputsFor({ slots: { "clip-a": "a", "clip-b": "b", music: "m" } }));
    const music = tracksOf(editor).audio[0]?.elements[0];
    expect(music && sec(music.duration)).toBe(12.5);
    sourceMappingHolds(editor);
  });

  it("keeps audio on an audio track, trimmed to the beat", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }, { id: "b", type: "video", seconds: 8 }, { id: "m", type: "audio", seconds: 30 }]);
    applyTemplateToEditor(editor, base(), inputsFor({ slots: { "clip-a": "a", "clip-b": "b", music: "m" } }));
    const music = tracksOf(editor).audio[0]?.elements[0];
    expect(music && [sec(music.duration), sec(music.trimEnd)]).toEqual([10, 20]);
    sourceMappingHolds(editor);
  });

  it("ignores a wrong-kind or unknown asset with a warning rather than failing", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }, { id: "snd", type: "audio" }]);
    const result = applyTemplateToEditor(editor, base(), { slots: { "clip-a": "a", "clip-b": "snd", music: "ghost" } });
    expect(result.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["wrong-kind", "unknown-asset"]));
    expect(result.missingSlots).toEqual(["clip-b"]);
    checkInvariants(editor);
  });

  it("applies a filter as one adjust effect scaled by intensity", () => {
    const template = sampleTemplate({
      beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a", filter: { preset: "vivid", intensity: 0.5 } } }],
    });
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }]);
    applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" } });
    const clip = tracksOf(editor).main.elements[0];
    const adjust = clip && "effects" in clip ? clip.effects?.find((e) => e.type === "adjust") : undefined;
    expect(adjust?.params["saturation"]).toBe(20);
  });

  it("push-in writes scale keyframes over the clip", () => {
    const template = sampleTemplate({ beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a", pushIn: 1.2 } }] });
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }]);
    applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" } });
    const clip = tracksOf(editor).main.elements[0];
    const keys = clip?.animations?.[PARAM.scaleX];
    expect(keys).toBeDefined();
    checkInvariants(editor);
  });

  it("mutes the source audio when the beat says so", () => {
    const template = sampleTemplate({ beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a", audio: "mute" } }] });
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }]);
    applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" } });
    const clip = tracksOf(editor).main.elements[0];
    expect(clip?.type === "video" && clip.isSourceAudioEnabled).toBe(false);
  });
});

describe("applyTemplateToEditor: text handling", () => {
  it("truncates over-long user text and says so", () => {
    const editor = editorWith([{ id: "a", type: "video" }]);
    const template = sampleTemplate({ texts: [{ id: "title", label: "Title", default: "Hi", style: "headline", maxChars: 10 }] });
    const result = applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" }, texts: { title: "This is far too long to fit" } });
    expect(result.warnings.map((w) => w.code)).toContain("text-truncated");
    const title = elementsOf(editor).find((e) => e.type === "text");
    expect(String(title?.params[PARAM.content]).replace(/\n/g, " ").length).toBeLessThanOrEqual(10);
  });

  it("drops a text the user blanked out", () => {
    const editor = editorWith([{ id: "a", type: "video" }]);
    applyTemplateToEditor(editor, sampleTemplate(), { slots: { "clip-a": "a" }, texts: { title: "   " } });
    expect(elementsOf(editor).filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("wraps long text and shrinks a word that cannot fit, with a warning", () => {
    const editor = editorWith([{ id: "a", type: "video" }]);
    const result = applyTemplateToEditor(editor, sampleTemplate(), {
      slots: { "clip-a": "a" }, texts: { title: "Antidisestablishmentarianism-and-other-extraordinarily-long-words" },
    });
    expect(result.warnings.map((w) => w.code)).toContain("text-shrunk");
    const title = elementsOf(editor).find((e) => e.type === "text");
    const px = Number(title?.params[PARAM.fontSize]) * (1080 / 90);
    expect(px).toBeLessThan(110);
    expect(px).toBeGreaterThanOrEqual(110 * 0.45 - 1);

    const wrapped = editorWith([{ id: "a", type: "video" }]);
    applyTemplateToEditor(wrapped, sampleTemplate(), { slots: { "clip-a": "a" }, texts: { title: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen" } });
    const lines = String(elementsOf(wrapped).find((e) => e.type === "text")?.params[PARAM.content]).split("\n");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("skips the animation when the text clip is too short for one", () => {
    const template = sampleTemplate({ beats: [{ id: "a", at: 0, duration: 5, media: { slot: "clip-a" }, layers: [{ kind: "text", text: "title", at: 0, duration: 0.05 }] }] });
    const editor = editorWith([{ id: "a", type: "video" }]);
    applyTemplateToEditor(editor, template, { slots: { "clip-a": "a" } });
    checkInvariants(editor);
  });

  it("styles caption cues with the template's caption preset", () => {
    const template = sampleTemplate({ captions: { style: "bold-lower" } });
    const editor = editorWith([{ id: "a", type: "video" }, { id: "b", type: "video" }]);
    const result = applyTemplateToEditor(editor, template, {
      slots: { "clip-a": "a", "clip-b": "b" },
      captionCues: [{ start: 0.5, end: 2, text: "hello there" }, { start: 2, end: 4, text: "general kenobi" }, { start: 5, end: 4, text: "bad cue" }],
    });
    const captions = elementsOf(editor).filter((e) => e.type === "text" && e.name.startsWith("Caption"));
    expect(captions).toHaveLength(2);
    expect(captions[0]?.params[PARAM.positionY]).toBeGreaterThan(0);
    expect(captions[0]?.params[PARAM.strokeWidth]).toBeGreaterThan(0);
    expect(result.warnings.map((w) => w.code)).toContain("caption-skipped");
    checkInvariants(editor);
  });

  it("warns that cues were ignored when the template has no caption style", () => {
    const editor = editorWith([{ id: "a", type: "video" }]);
    const result = applyTemplateToEditor(editor, sampleTemplate(), { slots: { "clip-a": "a" }, captionCues: [{ start: 0, end: 1, text: "x" }] });
    expect(result.warnings.map((w) => w.code)).toContain("caption-skipped");
  });
});

describe("applyTemplateToEditor: repeat groups", () => {
  const template = getTemplate("listicle") as ProjectTemplate;

  const run = (items: number, extra: Partial<TemplateInputs> = {}) => {
    const { specs, inputs } = fillAll(template, { items });
    const editor = editorWith(specs);
    const result = applyTemplateToEditor(editor, template, { ...inputs, ...extra });
    return { editor, result, specs };
  };

  it("lays out N items back to back, numbers them and moves the outro after the last", () => {
    for (const n of [3, 4, 5]) {
      const { editor, result } = run(n);
      checkInvariants(editor);
      const numbers = elementsOf(editor).filter((e) => e.type === "text" && /^\d$/.test(String(e.params[PARAM.content]))).map((e) => String(e.params[PARAM.content]));
      expect(numbers.sort()).toEqual(Array.from({ length: n }, (_, i) => String(i + 1)));
      expect(result.durationSeconds).toBe(3 + n * 6 + 3);
      const clips = elementsOf(editor).filter((e) => e.type === "video");
      expect(clips).toHaveLength(n);
    }
  });

  it("pads with empty items below the minimum and drops items above the maximum, with warnings", () => {
    const few = run(1);
    expect(few.result.warnings.map((w) => w.code)).toContain("repeat-count");
    expect(few.result.durationSeconds).toBe(3 + 3 * 6 + 3);
    const many = run(9);
    expect(many.result.warnings.some((w) => w.code === "repeat-count" && w.message.includes("at most 5"))).toBe(true);
    expect(many.result.durationSeconds).toBe(3 + 5 * 6 + 3);
    checkInvariants(many.editor);
  });

  it("uses each item's own words", () => {
    const { specs, inputs } = fillAll(template, { items: 3 });
    const repeat = { items: (inputs.repeat?.["items"] ?? []).map((item, i) => ({ ...item, texts: { title: `Tip number ${i + 1}!` } })) };
    const editor = editorWith(specs);
    applyTemplateToEditor(editor, template, { ...inputs, repeat });
    const contents = elementsOf(editor).filter((e) => e.type === "text").map((e) => String(e.params[PARAM.content]).replace(/\n/g, " "));
    expect(contents).toEqual(expect.arrayContaining(["Tip number 1!", "Tip number 2!", "Tip number 3!"]));
  });

  it("reports an item whose clip is missing but keeps the rest", () => {
    const { specs, inputs } = fillAll(template, { items: 3 });
    const items = [...(inputs.repeat?.["items"] ?? [])];
    items[1] = { slots: {} };
    const editor = editorWith(specs);
    const result = applyTemplateToEditor(editor, template, { ...inputs, repeat: { items } });
    expect(result.missingSlots).toEqual(["Item 2: clip"]);
    checkInvariants(editor);
  });
});

describe("applyTemplateToEditor: guards", () => {
  it("refuses a non-empty timeline unless replace is set, and replace is still one undo step", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }, { id: "b", type: "video", seconds: 8 }]);
    const template = sampleTemplate();
    const inputs = { slots: { "clip-a": "a", "clip-b": "b" } };
    applyTemplateToEditor(editor, template, inputs);
    const countAfterFirst = elementsOf(editor).length;
    const afterFirst = editor.getState();
    expect(() => applyTemplateToEditor(editor, template, inputs)).toThrow(TemplateApplyError);
    expect(editor.getState().doc).toBe(afterFirst.doc);

    applyTemplateToEditor(editor, template, inputs, { replace: true });
    checkInvariants(editor);
    expect(elementsOf(editor).length).toBe(countAfterFirst);
    editor.undo();
    expect(editor.getState().doc).toBe(afterFirst.doc);
  });

  it("changes nothing when a required slot is missing and requireAllSlots is set", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }]);
    const before = editor.getState().doc;
    try {
      applyTemplateToEditor(editor, sampleTemplate(), { slots: { "clip-a": "a" } }, { requireAllSlots: true });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateApplyError);
      expect((error as TemplateApplyError).code).toBe("missing-slots");
      expect((error as TemplateApplyError).message).toContain("clip-b");
    }
    expect(editor.getState().doc).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
  });

  it("rolls the whole turn back if anything throws mid-way", () => {
    const editor = editorWith([{ id: "a", type: "video", seconds: 8 }]);
    const before = editor.getState().doc;
    const original = editor.execute.bind(editor);
    let calls = 0;
    editor.execute = (command) => {
      if (++calls === 4) throw new Error("injected failure");
      original(command);
    };
    expect(() => applyTemplateToEditor(editor, sampleTemplate(), { slots: { "clip-a": "a" } })).toThrow("injected failure");
    editor.execute = original;
    expect(editor.getState().doc).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
  });

  it("planTemplate is pure: no editor, repeatable output", () => {
    const template = getTemplate("product-launch") as ProjectTemplate;
    const { specs, inputs } = fillAll(template);
    const assets = specs.map(assetOf);
    const a = planTemplate({ template, inputs, assets });
    const b = planTemplate({ template, inputs, assets });
    expect(a).toEqual(b);
    expect(a.clips.every((c) => Number.isInteger(c.start) && Number.isInteger(c.duration) && c.duration >= 1)).toBe(true);
    expect(parseTemplate(JSON.parse(JSON.stringify(template)))).toEqual(template);
  });
});
