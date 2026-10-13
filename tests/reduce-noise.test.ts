import { describe, expect, it } from "vitest";
import { callTool, createNoiseTools, type AgentTool } from "#/engine/agent";
import { currentScene } from "#/engine/commands";
import { PARAM, numberParam } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

function setup(prepare?: (assetId: string) => Promise<{ noiseFloorBeforeDb: number; noiseFloorAfterDb: number }>) {
  const { editor } = makeEditor({ assets: ASSETS });
  const tools = new Map<string, AgentTool>(createNoiseTools(prepare ? { prepare: ({ assetId }) => prepare(assetId) } : {}).map((t) => [t.name, t]));
  const ctx = { editor, nowMs: () => 0 };
  return { editor, call: (args: unknown) => callTool({ tools, name: "reduce_noise", args, ctx }) };
}

import { createAgentTools } from "#/engine/agent";

async function withClips() {
  const h = setup(async () => ({ noiseFloorBeforeDb: -32.04, noiseFloorAfterDb: -58.96 }));
  const base = createAgentTools();
  const ctx = { editor: h.editor, nowMs: () => 0 };
  const video = await callTool({ tools: base, name: "insert_media", args: { assetId: "a1", start: 0 }, ctx });
  const music = await callTool({ tools: base, name: "insert_media", args: { assetId: "music", start: 0 }, ctx });
  const photo = await callTool({ tools: base, name: "insert_media", args: { assetId: "photo", start: 12 }, ctx });
  const id = (r: typeof video): string => (r.ok ? (r.data as { elementId: string }).elementId : "");
  return { ...h, videoId: id(video), musicId: id(music), photoId: id(photo) };
}

const strengthOf = (editor: ReturnType<typeof makeEditor>["editor"], elementId: string): number => {
  const tracks = currentScene(editor.getState().doc).tracks;
  const el = allElements(tracks).find((l) => l.element.id === elementId)?.element;
  return numberParam(el?.params ?? {}, PARAM.denoise, 0);
};

describe("reduce_noise", () => {
  it("sets the strength on video and audio clips in one undo step and reports the measured floor", async () => {
    const h = await withClips();
    const doc = h.editor.getState().doc;
    const result = await h.call({ elementIds: [h.videoId, h.musicId], strength: 0.7 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(strengthOf(h.editor, h.videoId)).toBe(0.7);
    expect(strengthOf(h.editor, h.musicId)).toBe(0.7);
    if (result.ok) {
      expect(result.summary).toMatch(/-32 dBFS -> -59 dBFS|-32\.0 dBFS -> -59\.0 dBFS/);
      expect(result.data).toMatchObject({ measured: [{ assetId: "a1" }, { assetId: "music" }] });
    }
    h.editor.undo();
    expect(h.editor.getState().doc).toBe(doc);
  });

  it("defaults to full strength, turns off with 0 and does not analyse when turning off", async () => {
    const asked: string[] = [];
    const h = setup(async (id) => { asked.push(id); return { noiseFloorBeforeDb: -40, noiseFloorAfterDb: -60 }; });
    const base = createAgentTools();
    const ctx = { editor: h.editor, nowMs: () => 0 };
    const inserted = await callTool({ tools: base, name: "insert_media", args: { assetId: "music", start: 0 }, ctx });
    const id = inserted.ok ? (inserted.data as { elementId: string }).elementId : "";
    await h.call({ elementIds: [id] });
    expect(strengthOf(h.editor, id)).toBe(1);
    await h.call({ elementIds: [id], strength: 0 });
    expect(strengthOf(h.editor, id)).toBe(0);
    expect(asked).toEqual(["music"]);
  });

  it("refuses images and videos without sound, and a failed analysis leaves the project untouched", async () => {
    const h = await withClips();
    const image = await h.call({ elementIds: [h.photoId] });
    expect(image.ok).toBe(false);
    if (!image.ok) expect(image.error).toMatch(/no audio/);
    const failing = setup(async () => { throw new Error("This file has 40 minutes of audio"); });
    const ctx = { editor: failing.editor, nowMs: () => 0 };
    const inserted = await callTool({ tools: createAgentTools(), name: "insert_media", args: { assetId: "music", start: 0 }, ctx });
    const id = inserted.ok ? (inserted.data as { elementId: string }).elementId : "";
    const doc = failing.editor.getState().doc;
    const result = await failing.call({ elementIds: [id] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/40 minutes/);
    expect(failing.editor.getState().doc).toBe(doc);
  });

  it("rejects strengths outside 0..1 through the schema", async () => {
    const h = await withClips();
    expect((await h.call({ elementIds: [h.musicId], strength: 1.5 })).ok).toBe(false);
  });
});
