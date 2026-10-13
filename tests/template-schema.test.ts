import { describe, expect, it } from "vitest";
import {
  TEMPLATE_LIMITS, TemplateValidationError, parseTemplate, parseTemplateJson, safeParseTemplate, type TemplateIssue,
} from "#/engine/templates";
import { getTemplate, listTemplates } from "#/templates";
import { sampleTemplate } from "./template-support";

const VALID = {
  format: "runitback-template", templateVersion: 1, id: "t", name: "T", description: "d", category: "launch", tags: [],
  canvas: { aspect: "16:9", fps: 30 }, durationSeconds: 5,
  slots: [{ id: "clip", kind: "video", label: "Clip" }],
  texts: [{ id: "title", label: "Title", default: "Hi", style: "headline" }],
  beats: [{ id: "b", at: 0, duration: 5, media: { slot: "clip" }, layers: [{ kind: "text", text: "title" }] }],
};

const clone = (): Record<string, unknown> => structuredClone(VALID);

type Json = Record<string, unknown>;
const REMOVE = Symbol("remove");

/** Sets (or removes) the value at a dotted path such as `beats.0.media.slot` on a deep copy of the valid template. */
function withPath(path: string, value: unknown, base: Json = clone()): Json {
  const keys = path.split(".");
  let node: Json = base;
  for (const key of keys.slice(0, -1)) node = node[key] as Json;
  const last = keys[keys.length - 1] as string;
  if (value === REMOVE) delete node[last];
  else node[last] = value;
  return base;
}

function issuesOf(input: unknown): TemplateIssue[] {
  const result = safeParseTemplate(input);
  if (result.ok) throw new Error("expected the template to be rejected");
  return result.issues;
}

describe("template schema: valid input", () => {
  it("accepts a minimal template and returns a fresh normalized object", () => {
    const input = clone();
    const result = safeParseTemplate(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template).not.toBe(input);
      expect(result.template.canvas).toEqual({ aspect: "16:9", fps: 30 });
      expect(result.template.repeat).toBeUndefined();
    }
  });

  it("every shipped template parses, has unique ids and point at preview files that exist", async () => {
    const { existsSync } = await import("node:fs");
    const ids = listTemplates().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const t of listTemplates()) {
      expect(getTemplate(t.id)).toBe(t);
      if (t.preview) {
        expect(existsSync(`public/templates/${t.preview.poster}`), `${t.id} poster`).toBe(true);
        expect(existsSync(`public/templates/${t.preview.video}`), `${t.id} video`).toBe(true);
      }
    }
  });

  it("round-trips through JSON text", () => {
    const template = sampleTemplate();
    expect(parseTemplateJson(JSON.stringify(template))).toEqual(template);
  });
});

describe("template schema: invalid input", () => {
  const GRAPHIC_LAYER = { kind: "graphic", shape: "star", box: { x: 0, y: 0, width: 10, height: 10 } };
  it.each<[string, string, unknown, string, string]>([
    ["wrong format", "format", "other", "bad-value", ".format"],
    ["future version", "templateVersion", 2, "unsupported-version", ".templateVersion"],
    ["uppercase id", "id", "Bad Id", "bad-value", ".id"],
    ["unknown top-level key", "extra", 1, "unknown-key", ".extra"],
    ["unknown category", "category", "memes", "bad-value", ".category"],
    ["fps out of range", "canvas.fps", 500, "out-of-range", ".canvas.fps"],
    ["fps not a number", "canvas.fps", "30", "wrong-type", ".canvas.fps"],
    ["negative duration", "beats.0.duration", -1, "out-of-range", ".beats[0].duration"],
    ["zero duration", "beats.0.duration", 0, "out-of-range", ".beats[0].duration"],
    ["unknown slot ref", "beats.0.media.slot", "nope", "unknown-ref", ".beats[0].media.slot"],
    ["unknown text ref", "beats.0.layers.0.text", "nope", "unknown-ref", ".beats[0].layers[0].text"],
    ["unknown style preset", "texts.0.style", "comic", "bad-value", ".texts[0].style"],
    ["unknown text param override", "texts.0.overrides", { glow: 3 }, "bad-value", ".texts[0].overrides.glow"],
    ["out-of-range text param override", "texts.0.overrides", { "stroke.width": 9000 }, "bad-value", ".texts[0].overrides.stroke.width"],
    ["override of the content", "texts.0.overrides", { content: "x" }, "bad-value", ".texts[0].overrides.content"],
    ["unknown filter", "beats.0.media.filter", { preset: "sparkle" }, "bad-value", ".beats[0].media.filter.preset"],
    ["unknown transition", "beats.0.media.transitionIn", { type: "spin" }, "bad-value", ".beats[0].media.transitionIn.type"],
    ["crop edges that remove everything", "beats.0.media.crop", { left: 0.6, right: 0.6 }, "out-of-range", ".beats[0].media.crop"],
    ["zoom below 1", "beats.0.media.zoom", { scale: 0.5 }, "out-of-range", ".beats[0].media.zoom.scale"],
    ["layer starting after its beat", "beats.0.layers.0.at", 9, "out-of-range", ".beats[0].layers[0].at"],
    ["beat running past the limit", "beats.0.at", 599, "out-of-range", ".beats[0]"],
    ["graphic geometry through params", "beats.0.layers", [GRAPHIC_LAYER, { ...GRAPHIC_LAYER, params: { "transform.scaleX": 4 } }], "bad-value", ".beats[0].layers[1].params.transform.scaleX"],
    ["unknown graphic param", "beats.0.layers", [{ ...GRAPHIC_LAYER, params: { points: 99 } }], "bad-value", ".beats[0].layers[0].params.points"],
    ["preview that is a URL", "preview", { poster: "https://evil.example/p.webp", video: "a.mp4" }, "bad-value", ".preview.poster"],
    ["preview with a path", "preview", { poster: "../p.webp", video: "a.mp4" }, "bad-value", ".preview.poster"],
    ["afterRepeat without that group", "beats.0.afterRepeat", "g", "unknown-ref", ".beats[0].afterRepeat"],
    ["a bad hex colour", "canvas.backgroundColor", "red", "bad-value", ".canvas.backgroundColor"],
    ["a text default longer than maxChars", "texts.0.maxChars", 1, "too-long", ".texts[0].default"],
  ])("rejects %s", (_name, path, value, code, errorPath) => {
    const base = path === "texts.0.maxChars" ? withPath("texts.0.default", "Hello") : clone();
    const issues = issuesOf(withPath(path, value, base));
    expect(issues.some((i) => i.code === code && i.path === errorPath), JSON.stringify(issues)).toBe(true);
  });

  it("rejects duplicate ids, empty beats and kind mismatches", () => {
    const dup = withPath("slots", [VALID.slots[0], VALID.slots[0]]);
    expect(issuesOf(dup).some((i) => i.code === "duplicate-id" && i.path === ".slots[1].id")).toBe(true);
    const empty = withPath("beats.0.layers", REMOVE, withPath("beats.0.media", REMOVE));
    expect(issuesOf(empty).some((i) => i.code === "empty" && i.path === ".beats[0]")).toBe(true);
    const audio = withPath("beats.0.media.fit", "cover", withPath("slots.0.kind", "audio"));
    expect(issuesOf(audio).some((i) => i.code === "kind-mismatch")).toBe(true);
    const image = withPath("beats.0.media.onShort", "loop", withPath("slots.0.kind", "image"));
    expect(issuesOf(image).some((i) => i.code === "kind-mismatch")).toBe(true);
  });

  it("rejects non-objects without throwing", () => {
    for (const value of [null, undefined, 3, "x", [], true, () => 1, Symbol("s")]) {
      expect(safeParseTemplate(value).ok).toBe(false);
    }
    expect(() => parseTemplate(null)).toThrow(TemplateValidationError);
  });

  it("validates repeat groups: scoped ids, bounds and refs", () => {
    const base = sampleTemplate({
      beats: [{ id: "intro", at: 0, duration: 2, layers: [{ kind: "text", text: "title" }] }],
      repeat: [{
        id: "items", label: "Item", min: 2, max: 4, at: 2, itemSeconds: 3,
        slots: [{ id: "clip", kind: "video", label: "Clip" }], texts: [{ id: "name", label: "Name", default: "{n}", style: "headline" }],
        beats: [{ id: "item", at: 0, duration: 3, media: { slot: "clip" }, layers: [{ kind: "text", text: "name" }] }],
      }],
    });
    expect(base.repeat?.[0]?.max).toBe(4);
    const bad = (path: string, value: unknown): TemplateIssue[] => {
      const raw = JSON.parse(JSON.stringify(base)) as Json;
      return issuesOf(withPath(path, value, raw));
    };
    expect(bad("repeat.0.min", 5).some((i) => i.path === ".repeat[0].min")).toBe(true);
    expect(bad("repeat.0.max", 99).some((i) => i.code === "out-of-range")).toBe(true);
    expect(bad("repeat.0.beats.0.media.slot", "clip-a").some((i) => i.code === "unknown-ref")).toBe(true);
    expect(bad("repeat.0.beats.0.duration", 9).some((i) => i.code === "out-of-range")).toBe(true);
    expect(bad("repeat.0.beats.0.afterRepeat", "items").some((i) => i.path === ".repeat[0].beats[0].afterRepeat")).toBe(true);
  });
});

describe("template schema: hostile input", () => {
  it("rejects __proto__, constructor and prototype keys anywhere, and pollutes nothing", () => {
    const poisoned = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    expect(safeParseTemplate(poisoned).ok).toBe(false);
    const nested = withPath("texts.0.overrides", JSON.parse('{"__proto__":{"polluted":true},"fontSize":3}'));
    const result = safeParseTemplate(nested);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "forbidden-key")).toBe(true);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    const ctor = JSON.parse('{"a":{"constructor":{"prototype":{"x":1}}}}') as unknown;
    expect(safeParseTemplate(ctor).ok).toBe(false);
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("rejects non-finite numbers, huge arrays and deep nesting", () => {
    expect(safeParseTemplate(withPath("durationSeconds", Number.NaN)).ok).toBe(false);
    expect(safeParseTemplate(withPath("durationSeconds", Number.POSITIVE_INFINITY)).ok).toBe(false);
    expect(safeParseTemplate(withPath("beats.0.duration", 1e308)).ok).toBe(false);
    const manyBeats = withPath("beats", Array.from({ length: TEMPLATE_LIMITS.maxBeats + 1 }, (_, i) => ({ ...VALID.beats[0], id: `b${i}` })));
    expect(issuesOf(manyBeats).some((i) => i.code === "too-many")).toBe(true);
    let deep: unknown = "x";
    for (let i = 0; i < 5000; i++) deep = { a: deep };
    expect(safeParseTemplate(withPath("extra", deep)).ok).toBe(false);
    const cyclic: Record<string, unknown> = clone();
    cyclic["self"] = cyclic;
    expect(safeParseTemplate(cyclic).ok).toBe(false);
  });

  it("bounds text and rejects control and bidi-override characters", () => {
    expect(safeParseTemplate(withPath("texts.0.default", "x".repeat(TEMPLATE_LIMITS.maxTextChars + 1))).ok).toBe(false);
    expect(safeParseTemplate(withPath("texts.0.default", "a\u202Eb")).ok).toBe(false);
    expect(safeParseTemplate(withPath("texts.0.default", "a\u0000b")).ok).toBe(false);
    expect(safeParseTemplate(withPath("name", "two\nlines")).ok).toBe(false);
    expect(safeParseTemplate(withPath("texts.0.default", "two\nlines")).ok).toBe(true);
  });

  it("caps the size of JSON text and reports bad JSON as a typed error", () => {
    const big = JSON.stringify({ ...VALID, description: "x".repeat(TEMPLATE_LIMITS.maxBytes) });
    expect(() => parseTemplateJson(big)).toThrow(/limit/);
    try {
      parseTemplateJson("{not json");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateValidationError);
      expect((error as TemplateValidationError).issues[0]?.code).toBe("not-json");
    }
  });

  it("refuses objects with a foreign prototype and survives throwing getters", () => {
    class Evil { id = "x"; }
    expect(safeParseTemplate(new Evil()).ok).toBe(false);
    const getter = clone();
    Object.defineProperty(getter, "name", { enumerable: true, get() { throw new Error("boom"); } });
    expect(safeParseTemplate(getter).ok).toBe(false);
  });

  it("bounds the total clips a template can create", () => {
    const layers = Array.from({ length: TEMPLATE_LIMITS.maxLayersPerBeat }, () => ({ kind: "text", text: "title" }));
    const beats = Array.from({ length: TEMPLATE_LIMITS.maxBeats }, (_, i) => ({ id: `b${i}`, at: i, duration: 1, layers }));
    const issues = issuesOf(withPath("beats", beats));
    expect(issues.some((i) => i.code === "too-many")).toBe(true);
  });
});
