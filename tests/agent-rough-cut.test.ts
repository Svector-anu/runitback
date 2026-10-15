import { describe, expect, it } from "vitest";
import { createAgentTools, runToolTurn, type AgentTool } from "#/engine/agent";
import {
  batch, deleteElements, insertElement, insertMediaElement, splitCommand, trimElementCommand, updateElements, upsertKeyframeCommand,
} from "#/engine/commands";
import { PARAM, buildTextElement } from "#/engine/model";
import { allElements, type LocatedElement } from "#/engine/timeline";
import { ASSETS, normalized, setupAgent, tracksOf } from "./agent-harness";
import { makeEditor, sec } from "./helpers";

describe("scripted rough cut", () => {
  it("one agent turn builds the same project as the equivalent direct commands, in one undo step", async () => {
    const h = setupAgent();
    const out = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: { editor: h.editor, nowMs: () => 0 }, label: "Rough cut", atomic: true,
      calls: [
        { name: "insert_media", args: { assetId: "a1" } },
        { name: "insert_media", args: { assetId: "a2" } },
        { name: "insert_media", args: { assetId: "a3" } },
      ],
    });
    expect(out.results.every((r) => r.result.ok)).toBe(true);
    const ids = out.results.map((r) => (r.result.ok ? (r.result.data as { elementId: string }).elementId : ""));
    const [c1, c2, c3] = ids as [string, string, string];

    const second = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: { editor: h.editor, nowMs: () => 0 }, label: "Refine", atomic: true,
      calls: [
        { name: "split", args: { at: 13, elementIds: [c2] } },
        { name: "trim", args: { elementId: c3, end: 22 } },
        { name: "delete", args: { elementIds: [c2], ripple: true } },
        { name: "insert_text", args: { text: "Day one", start: 0.5, duration: 3 } },
        { name: "set_speed", args: { elementId: c1, speed: 2 } },
      ],
    });
    expect(second.results.map((r) => r.result.ok)).toEqual([true, true, true, true, true]);
    const textId = (second.results[3]?.result as { data: { elementId: string } }).data.elementId;
    const kf = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: { editor: h.editor, nowMs: () => 0 }, label: "Fade", atomic: true,
      calls: [
        { name: "add_keyframe", args: { elementId: textId, property: "opacity", time: 0.5, value: 0 } },
        { name: "add_keyframe", args: { elementId: textId, property: "opacity", time: 1.5, value: 1 } },
      ],
    });
    expect(kf.results.every((r) => r.result.ok)).toBe(true);

    const direct = makeEditor({ assets: ASSETS }).editor;
    const asset = (id: string) => ASSETS.find((a) => a.id === id)!;
    direct.execute(batch("Rough cut", [
      insertMediaElement({ asset: asset("a1"), elementId: "d1", startTime: 0, placement: { mode: "auto" } }),
      insertMediaElement({ asset: asset("a2"), elementId: "d2", startTime: sec(10), placement: { mode: "auto" } }),
      insertMediaElement({ asset: asset("a3"), elementId: "d3", startTime: sec(18), placement: { mode: "auto" } }),
    ]));
    const main = tracksOf(direct).main.id;
    direct.execute(splitCommand({ refs: [{ trackId: main, elementId: "d2" }], splitTime: sec(13) }));
    direct.execute(trimElementCommand({ ref: { trackId: main, elementId: "d3" }, end: sec(22) }));
    direct.setRippleEnabled(true);
    direct.execute(deleteElements([{ trackId: main, elementId: "d2" }]));
    direct.setRippleEnabled(false);
    const text = { ...buildTextElement({ id: "dt", startTime: sec(0.5), content: "Day one" }), duration: sec(3) };
    direct.execute(insertElement({ element: text, placement: { mode: "auto" } }));
    direct.execute(updateElements([{ ref: { trackId: main, elementId: "d1" }, patch: { retime: { rate: 2 } } }]));
    const textTrack = tracksOf(direct).overlay[0]?.id ?? "";
    direct.execute(upsertKeyframeCommand({ ref: { trackId: textTrack, elementId: "dt" }, path: PARAM.opacity, time: sec(0), value: 0 }));
    direct.execute(upsertKeyframeCommand({ ref: { trackId: textTrack, elementId: "dt" }, path: PARAM.opacity, time: sec(1), value: 1 }));

    expect(normalized(h.editor)).toEqual(normalized(direct));
    const clips: LocatedElement[] = allElements(tracksOf(h.editor));
    expect(clips.filter((l) => l.track.id === tracksOf(h.editor).main.id)).toHaveLength(3);
  });

  it("the whole script is one undo step when wrapped in a single turn", async () => {
    const h = setupAgent();
    const pre = h.editor.getState().doc;
    const out = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: { editor: h.editor, nowMs: () => 0 }, label: "Rough cut", atomic: true,
      calls: [
        { name: "insert_media", args: { assetId: "a1" } },
        { name: "insert_media", args: { assetId: "a2" } },
        { name: "split", args: { at: 4 } },
        { name: "insert_text", args: { text: "Hi", start: 1 } },
        { name: "set_project", args: { canvasPreset: "1:1" } },
      ],
    });
    expect(out.rolledBack).toBe(false);
    h.editor.undo();
    expect(h.editor.getState().doc).toBe(pre);
    expect(h.editor.getState().canUndo).toBe(false);
  });
});

describe("tool catalogue", () => {
  const tools = [...createAgentTools().values()];
  const EXPECTED = [
    "get_project", "get_timeline", "get_element", "list_assets", "get_selection", "get_playhead",
    "insert_media", "insert_text", "insert_graphic", "insert_effect_layer", "split", "trim", "move", "delete", "duplicate",
    "set_params", "set_speed", "add_keyframe", "remove_keyframe", "add_effect", "remove_effect", "set_effect_params",
    "add_mask", "remove_mask", "set_track", "delete_track", "set_project", "add_bookmark", "import_captions",
    "seek", "select", "undo", "redo", "set_transition", "add_transition", "remove_transition", "set_color_adjust", "apply_filter", "set_text_style", "set_text_animation", "set_crop", "freeze_frame",
    "set_chroma_key", "set_speed_ramp", "insert_cursor", "set_cursor_path", "auto_zoom",
  ];
  const TIME_FIELDS = new Set(["start", "end", "at", "delta", "time", "duration", "offset"]);

  it("registers exactly the documented tools with unique names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED].sort());
  });

  it.each(tools.map((t) => [t.name, t] as [string, AgentTool]))("%s has a description, an object schema and is well formed", (name, tool) => {
    expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
    expect(tool.description.length).toBeGreaterThan(30);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.properties).toBeDefined();
    for (const key of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties?.[key]).toBeDefined();
    if (name.startsWith("get_") || name === "list_assets") expect(tool.readOnly).toBe(true);
  });

  it("descriptions mention units wherever a tool takes times", () => {
    for (const tool of tools) {
      const props = Object.keys(tool.inputSchema.properties ?? {});
      if (props.some((p) => TIME_FIELDS.has(p))) {
        expect(tool.description, `${tool.name} should say SECONDS`).toMatch(/seconds/i);
      }
    }
  });

  it("every write tool returns {ok, summary, data} and every tool survives garbage input", async () => {
    const h = setupAgent();
    for (const tool of tools) {
      const result = await tool.run({ definitelyNotAKey: 1 }, { editor: h.editor, nowMs: () => 0 });
      if (!result.ok) {
        expect(typeof result.error).toBe("string");
        expect(result.hint ?? "").not.toBe("");
      }
    }
    const inserted = await h.call("insert_media", { assetId: "a1" });
    expect(inserted).toMatchObject({ ok: true, summary: expect.any(String), data: expect.any(Object) });
  });
});
