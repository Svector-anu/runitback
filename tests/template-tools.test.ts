import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, createTemplateTools, runToolTurn, type AgentToolRegistry, type ToolResult } from "#/engine/agent";
import { currentScene } from "#/engine/commands";
import { PARAM } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { listTemplates } from "#/templates";
import { sec } from "./helpers";
import { checkInvariants, editorWith, type AssetSpec } from "./template-support";

const ASSETS: AssetSpec[] = [
  { id: "r1", type: "video", seconds: 12 }, { id: "r2", type: "video", seconds: 9 }, { id: "r3", type: "video", seconds: 9 },
  { id: "song", type: "audio", seconds: 60 }, { id: "logo", type: "image" },
];

function setup() {
  const editor = editorWith(ASSETS);
  const tools: AgentToolRegistry = new Map([...createAgentTools(), ...createTemplateTools({ list: listTemplates }).map((t) => [t.name, t] as const)]);
  const ctx = { editor, nowMs: () => 0 };
  const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool({ tools, name, args, ctx });
  const data = async <T = Record<string, unknown>>(name: string, args?: unknown): Promise<T> => {
    const result = await call(name, args);
    if (!result.ok) throw new Error(`${name} failed: ${result.error} (${result.hint ?? ""})`);
    return result.data as T;
  };
  const failure = async (name: string, args?: unknown): Promise<{ error: string; hint: string }> => {
    const result = await call(name, args);
    expect(result.ok, `${name} should fail`).toBe(false);
    if (result.ok) throw new Error("unreachable");
    return { error: result.error, hint: result.hint ?? "" };
  };
  return { editor, tools, ctx, call, data, failure };
}

interface Row { id: string; name: string; category: string; aspect: string; durationSeconds: number; slots: Array<{ id: string; kind: string; optional: boolean }> }

describe("list_templates", () => {
  it("lists every shipped template with its slots and filters by category, aspect and word", async () => {
    const h = setup();
    const all = await h.data<{ templates: Row[] }>("list_templates");
    expect(all.templates.map((t) => t.id)).toEqual(listTemplates().map((t) => t.id));
    const launch = all.templates.find((t) => t.id === "product-launch");
    expect(launch?.slots.map((s) => s.id)).toEqual(["rec-1", "rec-2", "rec-3", "logo", "music"]);
    expect(launch?.slots.find((s) => s.id === "logo")?.optional).toBe(true);

    const vertical = await h.data<{ templates: Row[] }>("list_templates", { aspect: "9:16" });
    expect(vertical.templates.length).toBeGreaterThan(0);
    expect(vertical.templates.every((t) => t.aspect === "9:16")).toBe(true);
    expect((await h.data<{ templates: Row[] }>("list_templates", { category: "list" })).templates.map((t) => t.id)).toEqual(["listicle"]);
    expect((await h.data<{ templates: Row[] }>("list_templates", { query: "quote" })).templates.map((t) => t.id)).toContain("testimonial-quote");
  });

  it("does not touch the project or history", async () => {
    const h = setup();
    await h.data("list_templates");
    await h.data("describe_template", { templateId: "listicle" });
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("rejects a bad filter value with a model-readable error", async () => {
    const h = setup();
    const err = await h.failure("list_templates", { aspect: "21:9" });
    expect(err.error).toContain("aspect");
  });
});

describe("describe_template", () => {
  it("returns slots, texts with defaults and repeat groups", async () => {
    const h = setup();
    const d = await h.data<{ texts: Array<{ id: string; default: string }>; repeat: Array<{ id: string; min: number; max: number; slots: Array<{ id: string }>; texts: Array<{ id: string }> }> }>("describe_template", { templateId: "listicle" });
    expect(d.repeat[0]).toMatchObject({ id: "items", min: 3, max: 5 });
    expect(d.repeat[0]?.slots.map((s) => s.id)).toEqual(["clip"]);
    expect(d.repeat[0]?.texts.map((t) => t.id)).toEqual(["number", "title"]);
    const launch = await h.data<{ texts: Array<{ id: string; default: string }> }>("describe_template", { templateId: "product-launch" });
    expect(launch.texts.find((t) => t.id === "headline")?.default).toBe("Meet the faster way to work");
  });

  it("suggests the nearest id for a typo and lists the known ids", async () => {
    const h = setup();
    const err = await h.failure("describe_template", { templateId: "product-lunch" });
    expect(err.hint).toContain('Did you mean "product-launch"');
    expect(err.hint).toContain("kinetic-announcement");
  });
});

describe("apply_template", () => {
  const args = {
    templateId: "product-launch",
    slots: { "rec-1": "r1", "rec-2": "r2", "rec-3": "r3", logo: "logo", music: "song" },
    texts: { headline: "Ship faster", "end-url": "ship.dev" },
  };

  it("builds the video in one undo step and reports what it did", async () => {
    const h = setup();
    const result = await h.call("apply_template", args);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ templateId: "product-launch", durationSeconds: 25, canvas: { width: 1920, height: 1080 }, fps: 30 });
    const texts = allElements(currentScene(h.editor.getState().doc).tracks).flatMap((l) => (l.element.type === "text" ? [String(l.element.params[PARAM.content]).replace(/\n/g, " ")] : []));
    expect(texts).toEqual(expect.arrayContaining(["Ship faster", "ship.dev"]));
    checkInvariants(h.editor);
    expect(h.editor.undo()).toBe(true);
    expect(h.editor.getState().canUndo).toBe(false);
    expect(allElements(currentScene(h.editor.getState().doc).tracks)).toHaveLength(0);
  });

  it("is marked destructive and not read-only so it needs an approved plan", () => {
    const tool = setup().tools.get("apply_template");
    expect(tool?.destructive).toBe(true);
    expect(tool?.readOnly).toBe(false);
    expect(setup().tools.get("list_templates")?.readOnly).toBe(true);
    expect(setup().tools.get("describe_template")?.readOnly).toBe(true);
  });

  it("refuses with a hint when a required slot is not mapped, and changes nothing", async () => {
    const h = setup();
    const err = await h.failure("apply_template", { templateId: "product-launch", slots: { "rec-1": "r1" } });
    expect(err.error).toContain("rec-2");
    expect(err.hint).toContain("describe_template");
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("rejects unknown slot and text ids with the valid ones", async () => {
    const h = setup();
    const slot = await h.failure("apply_template", { templateId: "product-launch", slots: { "rec-9": "r1" } });
    expect(slot.hint).toContain("rec-1");
    const text = await h.failure("apply_template", { ...args, texts: { headlin: "x" } });
    expect(text.hint).toContain('Did you mean "headline"');
    const wrongType = await h.failure("apply_template", { ...args, texts: { headline: 3 } });
    expect(wrongType.error).toContain("must be a string");
  });

  it("rejects an asset that is not in the project", async () => {
    const h = setup();
    const err = await h.failure("apply_template", { ...args, slots: { ...args.slots, "rec-1": "ghost" } });
    expect(err.error).toContain('"ghost"');
    expect(err.hint).toContain("list_assets");
  });

  it("rejects an unknown template", async () => {
    const h = setup();
    const err = await h.failure("apply_template", { templateId: "nope" });
    expect(err.error).toContain("nope");
  });

  it("refuses to build on a non-empty timeline unless replace is set", async () => {
    const h = setup();
    await h.data("insert_media", { assetId: "r1" });
    const err = await h.failure("apply_template", args);
    expect(err.hint).toContain("replace");
    const ok = await h.call("apply_template", { ...args, replace: true });
    expect(ok.ok).toBe(true);
    checkInvariants(h.editor);
    h.editor.undo();
    expect(allElements(currentScene(h.editor.getState().doc).tracks)).toHaveLength(1);
  });

  it("fills repeat groups from a list of items", async () => {
    const h = setup();
    const result = await h.call("apply_template", {
      templateId: "listicle",
      repeat: { items: [{ slots: { clip: "r1" }, texts: { title: "Light it well" } }, { slots: { clip: "r2" } }, { slots: { clip: "r3" } }, { slots: { clip: "r1" } }] },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ durationSeconds: 3 + 4 * 6 + 3 });
    const bad = await h.failure("apply_template", { templateId: "listicle", repeat: { items: [{ slots: { reel: "r1" } }] }, replace: true });
    expect(bad.hint).toContain("clip");
    const worse = await h.failure("apply_template", { templateId: "listicle", repeat: { rows: [] }, replace: true });
    expect(worse.error).toContain("rows");
  });

  it("returns short-media warnings instead of failing", async () => {
    const h = setup();
    const result = await h.call("apply_template", { ...args, slots: { ...args.slots, "rec-2": "r2" }, replace: true });
    expect(result.ok).toBe(true);
    const shortened = setup();
    shortened.editor.registerAsset({ id: "tiny", name: "tiny.mp4", type: "video", size: 1, lastModified: 0, width: 1920, height: 1080, duration: sec(1) });
    const warn = await shortened.call("apply_template", { ...args, slots: { ...args.slots, "rec-2": "tiny" } });
    expect(warn.ok).toBe(true);
    if (warn.ok) expect((warn.data as { warnings: string[] }).warnings.join(" ")).toContain("last frame is held");
  });

  it("composes inside an atomic tool turn and rolls back with it", async () => {
    const h = setup();
    const turn = await runToolTurn({
      editor: h.editor, tools: h.tools, ctx: h.ctx, label: "Make launch video", atomic: true,
      calls: [{ name: "apply_template", args }, { name: "get_timeline", args: {} }, { name: "apply_template", args: { templateId: "ghost" } }],
    });
    expect(turn.rolledBack).toBe(true);
    expect(h.editor.getState().canUndo).toBe(false);
    expect(allElements(currentScene(h.editor.getState().doc).tracks)).toHaveLength(0);
  });
});
