import { describe, expect, it } from "vitest";
import { currentScene } from "#/engine/commands";
import { FILTER_PRESET_IDS, TEXT_ANIMATION_PRESETS, TRANSITION_TYPES } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import {
  TEMPLATE_ASPECTS, TEMPLATE_CATEGORIES, TEXT_STYLE_IDS, applyTemplateToEditor, safeParseTemplate, type TemplateInputs,
} from "#/engine/templates";
import { checkInvariants, editorWith, type AssetSpec } from "./template-support";

/** Small deterministic PRNG so a failing seed reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const int = (r: Rand, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rand, list: ReadonlyArray<T>): T => list[int(r, 0, list.length - 1)] as T;
const chance = (r: Rand, p: number): boolean => r() < p;
const seconds = (r: Rand, lo: number, hi: number): number => Math.round((lo + r() * (hi - lo)) * 100) / 100;

const WORDS = ["launch", "ship", "now", "Antidisestablishmentarianism", "a", "tiny", "emoji \u{1F680}", "line\nbreak", "{n}", "x".repeat(40)];

function randomText(r: Rand): string {
  return Array.from({ length: int(r, 1, 9) }, () => pick(r, WORDS)).join(" ");
}

function randomLayers(r: Rand, beatSeconds: number, texts: string[]): unknown[] {
  return Array.from({ length: int(r, 0, 4) }, () => {
    const at = chance(r, 0.5) ? seconds(r, 0, beatSeconds * 0.9) : undefined;
    const duration = chance(r, 0.5) ? seconds(r, 0.05, beatSeconds * 1.5) : undefined;
    const timing = { ...(at !== undefined ? { at } : {}), ...(duration !== undefined ? { duration } : {}) };
    if (texts.length > 0 && chance(r, 0.65)) {
      return {
        kind: "text", text: pick(r, texts), ...timing, ...(chance(r, 0.6) ? { position: { x: int(r, -900, 900), y: int(r, -900, 900) } } : {}),
        ...(chance(r, 0.5) ? { animation: { ...(chance(r, 0.7) ? { in: { preset: pick(r, TEXT_ANIMATION_PRESETS), seconds: seconds(r, 0.05, 3) } } : {}) } } : {}),
      };
    }
    return {
      kind: "graphic", shape: pick(r, ["rectangle", "ellipse", "polygon", "star", "cursor", "app-frame"] as const), ...timing,
      box: { x: int(r, -1500, 1500), y: int(r, -1500, 1500), width: int(r, 1, 3000), height: int(r, 1, 3000) },
      params: { fill: "#5b6cff", opacity: Math.round(r() * 100) / 100 },
    };
  });
}

function randomZooms(r: Rand): unknown[] {
  let at = seconds(r, 0, 3);
  return Array.from({ length: int(r, 1, 3) }, () => {
    const stop = {
      at, x: int(r, -900, 900), y: int(r, -500, 500), ...(chance(r, 0.6) ? { scale: seconds(r, 1.1, 8) } : {}),
      ...(chance(r, 0.4) ? { in: seconds(r, 0.04, 2) } : {}), ...(chance(r, 0.4) ? { hold: seconds(r, 0, 4) } : {}), ...(chance(r, 0.4) ? { out: seconds(r, 0, 2) } : {}),
    };
    at = Math.round((at + seconds(r, 0.1, 6)) * 100) / 100;
    return stop;
  });
}

function randomMedia(r: Rand, slotId: string, kind: string): Record<string, unknown> {
  if (kind === "audio") return { slot: slotId, ...(chance(r, 0.4) ? { sourceStart: seconds(r, 0, 30) } : {}) };
  return {
    slot: slotId,
    ...(chance(r, 0.3) ? { track: pick(r, ["main", "overlay"] as const) } : {}),
    ...(chance(r, 0.4) ? { fit: pick(r, ["cover", "contain"] as const) } : {}),
    ...(chance(r, 0.3) ? { crop: { left: seconds(r, 0, 0.4), right: seconds(r, 0, 0.4), top: seconds(r, 0, 0.4), bottom: seconds(r, 0, 0.4) } } : {}),
    ...(chance(r, 0.3) ? { zoom: { scale: seconds(r, 1, 4), x: int(r, -900, 900), y: int(r, -500, 500) } } : {}),
    ...(chance(r, 0.25) ? { pushIn: seconds(r, 1, 2) } : chance(r, 0.25) ? { autoZoom: randomZooms(r) } : {}),
    ...(chance(r, 0.3) ? { tilt: { ...(chance(r, 0.7) ? { x: int(r, -80, 80) } : {}), ...(chance(r, 0.7) ? { y: int(r, -80, 80) } : {}), ...(chance(r, 0.5) ? { perspective: seconds(r, 1, 10) } : {}) } } : {}),
    ...(chance(r, 0.3) ? { shadow: { ...(chance(r, 0.5) ? { opacity: int(r, 0, 100) } : {}), ...(chance(r, 0.5) ? { blur: int(r, 0, 200) } : {}), ...(chance(r, 0.3) ? { offsetY: int(r, -400, 400) } : {}) } } : {}),
    ...(chance(r, 0.3) ? { corners: int(r, 0, 50) } : {}),
    ...(chance(r, 0.3) ? { filter: { preset: pick(r, FILTER_PRESET_IDS), intensity: Math.round(r() * 10) / 10 } } : {}),
    ...(chance(r, 0.5) ? { transitionIn: { type: pick(r, TRANSITION_TYPES), seconds: seconds(r, 0.04, 3) } } : {}),
    ...(kind === "video" && chance(r, 0.6) ? { onShort: pick(r, ["hold", "loop", "shrink"] as const) } : {}),
    ...(kind === "video" && chance(r, 0.3) ? { sourceStart: seconds(r, 0, 40) } : {}),
    ...(kind === "video" && chance(r, 0.2) ? { audio: pick(r, ["keep", "mute"] as const) } : {}),
    ...(chance(r, 0.2) ? { track: "overlay", box: { x: int(r, -800, 800), y: int(r, -400, 400), width: int(r, 50, 1200), height: int(r, 50, 900) } } : {}),
  };
}

function randomBeats(r: Rand, slots: Array<{ id: string; kind: string }>, texts: string[], span: number, count: number, prefix: string): unknown[] {
  const chained = chance(r, 0.5);
  let cursor = 0;
  return Array.from({ length: count }, (_, i) => {
    let at = chained ? Math.min(cursor, span * 0.9) : seconds(r, 0, span * 0.8);
    let duration = seconds(r, 0.05, Math.max(0.1, chained ? Math.min(span - at, span / count + 1) : span - at));
    if (at + duration > span) duration = Math.max(0.05, Math.floor((span - at) * 100) / 100);
    if (at + duration > span) at = Math.max(0, Math.floor((span - duration) * 100) / 100);
    cursor = Math.round((at + duration) * 100) / 100;
    const slot = slots.length > 0 && chance(r, 0.7) ? pick(r, slots) : undefined;
    const layers = randomLayers(r, duration, texts);
    return {
      id: `${prefix}${i}`, at, duration,
      ...(slot ? { media: randomMedia(r, slot.id, slot.kind) } : {}),
      ...(layers.length > 0 || !slot ? { layers: layers.length > 0 ? layers : [{ kind: "graphic", shape: "ellipse", box: { x: 0, y: 0, width: 100, height: 100 } }] } : {}),
    };
  });
}

function randomTemplate(r: Rand): Record<string, unknown> {
  const slots = Array.from({ length: int(r, 0, 5) }, (_, i) => ({ id: `s${i}`, kind: pick(r, ["video", "video", "image", "audio"] as const), label: `Slot ${i}`, ...(chance(r, 0.4) ? { optional: true } : {}) }));
  const texts = Array.from({ length: int(r, 0, 4) }, (_, i) => {
    const fallback = randomText(r).slice(0, 100);
    return {
      id: `t${i}`, label: `Text ${i}`, default: fallback, style: pick(r, TEXT_STYLE_IDS),
      ...(chance(r, 0.3) ? { maxChars: Math.max(fallback.length, int(r, 20, 120)) } : {}), ...(chance(r, 0.3) ? { maxWidth: int(r, 200, 1800) } : {}),
    };
  });
  const textIds = texts.map((t) => t.id);
  const hasGroup = chance(r, 0.4);
  const groupSlots = Array.from({ length: int(r, 0, 2) }, (_, i) => ({ id: `g${i}`, kind: pick(r, ["video", "image"] as const), label: `Item slot ${i}` }));
  const groupTexts = Array.from({ length: int(r, 0, 2) }, (_, i) => ({ id: `gt${i}`, label: `Item text ${i}`, default: "Item {n} of {count}", style: pick(r, TEXT_STYLE_IDS) }));
  const itemSeconds = seconds(r, 0.5, 8);
  const min = int(r, 1, 3);
  const group = {
    id: "grp", label: "Item", min, max: min + int(r, 0, 4), at: seconds(r, 0, 5), itemSeconds, slots: groupSlots, texts: groupTexts,
    beats: randomBeats(r, groupSlots, groupTexts.map((t) => t.id), itemSeconds, int(r, 1, 3), "gb"),
  };
  const beats = randomBeats(r, slots, textIds, 60, int(r, hasGroup ? 0 : 1, 10), "b");
  if (hasGroup && chance(r, 0.6)) beats.push({ id: "after", at: seconds(r, 0, 2), duration: seconds(r, 0.5, 3), afterRepeat: "grp", layers: [{ kind: "graphic", shape: "star", box: { x: 0, y: 0, width: 200, height: 200 } }] });
  if (slots.some((s) => s.kind === "audio") && chance(r, 0.5)) {
    const audio = slots.find((s) => s.kind === "audio");
    if (audio) beats.push({ id: "bed", at: 0, duration: 1, toEnd: true, media: { slot: audio.id } });
  }
  return {
    format: "runitback-template", templateVersion: 1, id: "fuzz", name: "Fuzz", description: "Random.", category: pick(r, TEMPLATE_CATEGORIES), tags: [],
    canvas: {
      aspect: pick(r, TEMPLATE_ASPECTS), fps: pick(r, [24, 25, 30, 60]), ...(chance(r, 0.5) ? { backgroundColor: "#112233" } : {}),
      ...(chance(r, 0.3) ? { gradient: { style: pick(r, ["linear", "radial", "mesh"] as const), colors: ["#112233", "#8844ff", "#22ccaa"].slice(0, int(r, 2, 3)), ...(chance(r, 0.5) ? { angle: int(r, 0, 360) } : {}), ...(chance(r, 0.5) ? { motion: int(r, 0, 100) } : {}) } } : {}),
    },
    durationSeconds: 30, slots, texts, beats, ...(hasGroup ? { repeat: [group] } : {}),
  };
}

function randomAsset(r: Rand, id: string, wantKind: string): AssetSpec {
  const kind = chance(r, 0.08) ? pick(r, ["video", "image", "audio"] as const) : wantKind === "audio" ? "audio" : chance(r, 0.15) ? "image" : "video";
  const tiny = chance(r, 0.15);
  return {
    id, type: kind as AssetSpec["type"], seconds: tiny ? seconds(r, 0.001, 0.2) : seconds(r, 0.3, 90),
    width: pick(r, [1920, 1080, 640, 4000, 100]), height: pick(r, [1080, 1920, 360, 2000, 100]), hasAudio: chance(r, 0.7),
  };
}

describe("template fuzz: random templates x random media", () => {
  const RUNS = Number(process.env["TEMPLATE_FUZZ_RUNS"] ?? 200);
  const ONLY = process.env["TEMPLATE_FUZZ_SEED"];
  const stats = { clips: 0, warnings: 0, empty: 0, transitions: 0 };
  it(`keeps every invariant and one undo restores the empty project (${RUNS} seeds)`, () => {
    for (let seed = ONLY ? Number(ONLY) : 1; seed <= (ONLY ? Number(ONLY) : RUNS); seed++) {
      const r = rng(seed);
      const raw = randomTemplate(r);
      const parsed = safeParseTemplate(raw);
      if (!parsed.ok) throw new Error(`seed ${seed}: generator produced an invalid template: ${JSON.stringify(parsed.issues.slice(0, 3))}`);
      const template = parsed.template;

      const specs: AssetSpec[] = [];
      const inputs: { slots: Record<string, string>; texts: Record<string, string>; repeat?: Record<string, Array<{ slots: Record<string, string>; texts: Record<string, string> }>> } = { slots: {}, texts: {} };
      for (const slot of template.slots) {
        if (chance(r, 0.15)) continue;
        const spec = randomAsset(r, `a-${slot.id}`, slot.kind);
        specs.push(spec);
        inputs.slots[slot.id] = spec.id;
      }
      for (const text of template.texts) if (chance(r, 0.5)) inputs.texts[text.id] = chance(r, 0.1) ? "" : randomText(r);
      const group = template.repeat?.[0];
      if (group) {
        const count = int(r, 0, group.max + 3);
        inputs.repeat = { [group.id]: Array.from({ length: count }, (_, n) => {
          const item = { slots: {} as Record<string, string>, texts: {} as Record<string, string> };
          for (const slot of group.slots) if (chance(r, 0.8)) {
            const spec = randomAsset(r, `i${n}-${slot.id}`, slot.kind);
            specs.push(spec);
            item.slots[slot.id] = spec.id;
          }
          for (const text of group.texts) if (chance(r, 0.5)) item.texts[text.id] = randomText(r);
          return item;
        }) };
      }
      const cues = chance(r, 0.2) ? [{ start: seconds(r, 0, 5), end: seconds(r, 0, 8), text: randomText(r) }] : undefined;
      const full: TemplateInputs = { ...inputs, ...(cues ? { captionCues: cues } : {}) };

      if (ONLY) process.stderr.write(JSON.stringify({ specs, full }) + "\n");
      const editor = editorWith(specs);
      const before = editor.getState().doc;
      try {
        const applied = applyTemplateToEditor(editor, { ...template, ...(cues ? { captions: { style: "bold-lower" } } : {}) }, full);
        stats.clips += applied.elementIds.length;
        stats.warnings += applied.warnings.length;
        stats.empty += applied.elementIds.length === 0 ? 1 : 0;
        for (const { element } of allElements(currentScene(editor.getState().doc).tracks)) {
          if ((element.type === "video" || element.type === "image") && element.transition) stats.transitions++;
        }
        checkInvariants(editor);
        for (const { element } of allElements(currentScene(editor.getState().doc).tracks)) {
          expect(Number.isInteger(element.startTime) && Number.isInteger(element.duration), `seed ${seed} ints`).toBe(true);
          if (element.type === "video" || element.type === "audio") {
            expect(element.trimStart + element.duration + element.trimEnd, `seed ${seed} mapping ${element.id}`).toBe(element.sourceDuration);
          }
          expect(element.startTime + element.duration).toBeLessThan(25 * 3600 * TICKS_PER_SECOND);
        }
        const didEdit = editor.getState().canUndo;
        if (didEdit) {
          expect(editor.undo(), `seed ${seed} undo`).toBe(true);
          expect(editor.getState().canUndo, `seed ${seed} one step`).toBe(false);
        }
        expect(editor.getState().doc, `seed ${seed} restores the empty project`).toBe(before);
      } catch (error) {
        throw new Error(`seed ${seed} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n${JSON.stringify(raw)}`, { cause: error });
      }
    }
    expect(stats.clips, "the fuzz must build real timelines").toBeGreaterThan(RUNS);
    expect(stats.transitions, "and exercise transitions").toBeGreaterThan(0);
    expect(stats.warnings, "and exercise the fallbacks").toBeGreaterThan(0);
  }, 300_000);
});
