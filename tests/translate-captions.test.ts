import { describe, expect, it } from "vitest";
import { callTool, type AgentTool } from "#/engine/agent";
import { createTranslateTools } from "#/engine/agent/tools-translate";
import { captionElement } from "#/engine/agent/captions";
import { currentScene, insertElementsOnLanes } from "#/engine/commands";
import { PARAM, type TextElement } from "#/engine/model";
import { sceneViolations } from "#/engine/timeline";
import { createOpusTranslator, type TranslateBackend } from "#/platform/translate";
import { translatedCaption, type Translator } from "#/engine/translate";
import { makeEditor, sec } from "./helpers";

const CANVAS = { width: 1920, height: 1080 };

const SPANISH: Record<string, string> = {
  "Welcome to the show.": "Bienvenidos al programa.",
  "Today we are going to talk about editing video and a lot of other things that matter.": "Hoy vamos a hablar sobre la edición de video y muchas otras cosas que importan.",
};

const fakeTranslator = (calls: string[][] = []): Translator => ({
  async translate({ texts }) {
    calls.push([...texts]);
    return texts.map((t) => SPANISH[t] ?? `ES(${t})`);
  },
});

function setup(translator: Translator) {
  const { editor } = makeEditor();
  const tools = new Map<string, AgentTool>(createTranslateTools({ translator }).map((t) => [t.name, t]));
  const ctx = { editor, nowMs: () => 0 };
  const cues = [
    { text: "Welcome to the show.", start: 0, seconds: 2 },
    { text: "Today we are going to talk about editing video and a lot of other things that matter.", start: 2, seconds: 3 },
  ];
  const elements = cues.map((cue, i) =>
    captionElement({ cue: { text: cue.text, startTime: sec(cue.start), duration: sec(cue.seconds) }, index: i, id: `cap${i}`, canvas: CANVAS, startTime: sec(cue.start), duration: sec(cue.seconds) }));
  editor.execute(insertElementsOnLanes({ elements, index: 0, label: "Captions" }));
  const call = (args: unknown) => callTool({ tools, name: "translate_captions", args, ctx });
  const texts = (): TextElement[] => currentScene(editor.getState().doc).tracks.overlay.flatMap((t) => t.elements as TextElement[]);
  return { editor, call, texts };
}

describe("translate_captions", () => {
  it("adds a translated caption track with the same timing and style, keeps the originals, one undo step", async () => {
    const h = setup(fakeTranslator());
    const doc = h.editor.getState().doc;
    const result = await h.call({ targetLanguage: "es" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const all = h.texts();
    expect(all).toHaveLength(4);
    const originals = all.filter((e) => !e.name?.includes("(Spanish)"));
    const translated = all.filter((e) => e.name?.includes("(Spanish)")).sort((a, b) => a.startTime - b.startTime);
    expect(originals).toHaveLength(2);
    expect(translated.map((e) => String(e.params[PARAM.content]).replace(/\n/g, " "))).toEqual([
      "Bienvenidos al programa.",
      "Hoy vamos a hablar sobre la edición de video y muchas otras cosas que importan.",
    ]);
    translated.forEach((t, i) => {
      const source = originals.find((o) => o.startTime === t.startTime) as TextElement;
      expect(t.startTime).toBe(source.startTime);
      expect(t.duration).toBe(source.duration);
      expect(t.params[PARAM.color]).toBe(source.params[PARAM.color]);
      expect(t.id).not.toBe(source.id);
      expect(i).toBeLessThan(2);
    });
    expect(sceneViolations(currentScene(h.editor.getState().doc))).toEqual([]);
    h.editor.undo();
    expect(h.editor.getState().doc).toBe(doc);
  });

  it("translates only the given clips, and sends them to the translator in time order", async () => {
    const calls: string[][] = [];
    const h = setup(fakeTranslator(calls));
    const result = await h.call({ targetLanguage: "es", elementIds: ["cap1", "cap0"] });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["Welcome to the show.", "Today we are going to talk about editing video and a lot of other things that matter."]]);
  });

  it("rejects unsupported pairs without calling the model, and leaves the project alone when the model fails", async () => {
    const calls: string[][] = [];
    const h = setup(fakeTranslator(calls));
    const unsupported = await h.call({ targetLanguage: "ja" });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.hint).toMatch(/en->es/);
    expect(calls).toHaveLength(0);
    const failing = setup({ translate: async () => { throw new Error("The translation model is not downloaded"); } });
    const doc = failing.editor.getState().doc;
    const result = await failing.call({ targetLanguage: "es" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not downloaded/);
    expect(failing.editor.getState().doc).toBe(doc);
  });

  it("explains itself when there are no captions", async () => {
    const { editor } = makeEditor();
    const tools = new Map(createTranslateTools({ translator: fakeTranslator() }).map((t) => [t.name, t] as const));
    const result = await callTool({ tools, name: "translate_captions", args: { targetLanguage: "es" }, ctx: { editor, nowMs: () => 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no captions/i);
  });
});

describe("translatedCaption", () => {
  const source = captionElement({ cue: { text: "Short line", startTime: sec(0), duration: sec(2) }, index: 0, id: "s", canvas: CANVAS, startTime: sec(0), duration: sec(2) });

  it("re-wraps long translations inside the frame and moves the box up so a bottom caption never leaves the canvas", () => {
    const long = "Esta es una traducción bastante más larga que el texto original y necesita varias líneas dentro del encuadre del vídeo para leerse bien";
    const out = translatedCaption({ source, translated: long, id: "t", name: "Caption 1 (Spanish)", canvas: CANVAS });
    const lines = String(out.params[PARAM.content]).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(long);
    expect(Number(out.params[PARAM.positionY])).toBeLessThan(Number(source.params[PARAM.positionY]));
    expect(out.startTime).toBe(source.startTime);
    expect(out.duration).toBe(source.duration);
  });
});

describe("createOpusTranslator", () => {
  it("batches captions in order, disposes the worker, and rejects unsupported pairs", async () => {
    const batches: string[][] = [];
    let disposed = 0;
    const backend: TranslateBackend = {
      async translate({ texts }) {
        batches.push(texts);
        return texts.map((t) => t.toUpperCase());
      },
      dispose: () => { disposed++; },
    };
    const translator = createOpusTranslator({ createBackend: () => backend });
    const texts = Array.from({ length: 19 }, (_, i) => `caption ${i}`);
    expect(await translator.translate({ texts, source: "en", target: "es" })).toEqual(texts.map((t) => t.toUpperCase()));
    expect(batches.map((b) => b.length)).toEqual([8, 8, 3]);
    expect(disposed).toBe(1);
    await expect(translator.translate({ texts: ["x"], source: "en", target: "ja" })).rejects.toThrow(/not supported/);
  });

  it("aborts without leaving the worker running", async () => {
    let disposed = 0;
    const controller = new AbortController();
    const translator = createOpusTranslator({
      createBackend: () => ({
        translate: async () => { controller.abort(); return ["x"]; },
        dispose: () => { disposed++; },
      }),
    });
    await expect(translator.translate({ texts: Array.from({ length: 20 }, () => "a"), source: "en", target: "es", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(disposed).toBeGreaterThan(0);
  });
});
