import { describe, expect, it } from "vitest";
import { createAgentTools, runAgentTurn, runToolTurn } from "#/engine/agent";
import { deleteElements, insertMediaElement } from "#/engine/commands";
import { setupAgent, tracksOf, type InsertedData } from "./agent-harness";
import { videoAsset } from "./helpers";

describe("editor transactions", () => {
  it("collapses N edits into one undo step and redo reapplies the whole turn", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const pre = h.editor.getState();

    await runAgentTurn(h.editor, "Agent turn", async () => {
      await h.data("insert_media", { assetId: "a2" });
      const t = await h.data<InsertedData>("insert_text", { text: "x", start: 1 });
      await h.data("add_keyframe", { elementId: t.elementId, property: "opacity", time: 1, value: 0 });
      await h.data("split", { at: 4 });
    });
    const post = h.editor.getState();
    expect(post.doc).not.toBe(pre.doc);

    expect(h.editor.undo()).toBe(true);
    expect(h.editor.getState().doc).toBe(pre.doc);
    expect(h.editor.getState().selection).toBe(pre.selection);
    expect(h.editor.getState().canRedo).toBe(true);

    expect(h.editor.redo()).toBe(true);
    expect(h.editor.getState().doc).toBe(post.doc);
    expect(h.editor.getState().selection).toEqual(post.selection);

    h.editor.undo();
    h.editor.undo();
    expect(tracksOf(h.editor).main.elements).toHaveLength(0);
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("a turn that changes nothing leaves history alone", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    await runAgentTurn(h.editor, "Look around", async () => {
      await h.data("get_timeline");
      await h.data("seek", { time: 2 });
    });
    h.editor.undo();
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("an edit undone inside the turn leaves no step and keeps the redo stack", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    h.editor.undo();
    expect(h.editor.getState().canRedo).toBe(true);
    await runAgentTurn(h.editor, "Try and revert", async () => {
      await h.data("insert_media", { assetId: "a2" });
      await h.data("undo");
    });
    expect(h.editor.getState().canUndo).toBe(false);
    expect(h.editor.getState().canRedo).toBe(true);
  });

  it("undo and redo inside a turn only touch the turn's own steps", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    await runAgentTurn(h.editor, "Turn", async () => {
      expect((await h.failure("undo")).hint).toContain("turn");
      await h.data("insert_media", { assetId: "a2" });
      await h.data("insert_media", { assetId: "a3" });
      await h.data("undo");
      expect(tracksOf(h.editor).main.elements).toHaveLength(2);
      await h.data("redo");
      expect(tracksOf(h.editor).main.elements).toHaveLength(3);
      await h.failure("redo");
    });
    h.editor.undo();
    expect(tracksOf(h.editor).main.elements).toHaveLength(1);
  });

  it("rolls back exactly when the turn throws", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const pre = h.editor.getState();
    await expect(runAgentTurn(h.editor, "Doomed", async () => {
      await h.data("insert_media", { assetId: "a2" });
      await h.data("insert_text", { text: "x" });
      throw new Error("model gave up");
    })).rejects.toThrow("model gave up");
    const now = h.editor.getState();
    expect(now.doc).toBe(pre.doc);
    expect(now.selection).toBe(pre.selection);
    expect(now.canUndo).toBe(true);
    expect(h.editor.inTransaction).toBe(false);
    h.editor.undo();
    expect(h.editor.getState().canUndo).toBe(false);
    expect(h.editor.getState().canRedo).toBe(true);
  });

  it("rollback restores the redo stack too", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    await h.data("insert_media", { assetId: "a2" });
    h.editor.undo();
    const pre = h.editor.getState();
    await expect(runAgentTurn(h.editor, "Doomed", async () => {
      await h.data("insert_text", { text: "x" });
      throw new Error("fail");
    })).rejects.toThrow();
    expect(h.editor.getState().doc).toBe(pre.doc);
    expect(h.editor.getState().canRedo).toBe(true);
    h.editor.redo();
    expect(tracksOf(h.editor).main.elements).toHaveLength(2);
  });

  it("nested turns share the outer undo step; an inner rollback only reverts the inner work", async () => {
    const h = setupAgent();
    const pre = h.editor.getState().doc;
    await runAgentTurn(h.editor, "Outer", async () => {
      await h.data("insert_media", { assetId: "a1" });
      await runAgentTurn(h.editor, "Inner ok", async () => { await h.data("insert_media", { assetId: "a2" }); });
      await expect(runAgentTurn(h.editor, "Inner bad", async () => {
        await h.data("insert_media", { assetId: "a3" });
        throw new Error("inner");
      })).rejects.toThrow("inner");
      expect(tracksOf(h.editor).main.elements).toHaveLength(2);
    });
    h.editor.undo();
    expect(h.editor.getState().doc).toBe(pre);
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("commit and rollback without begin are programmer errors", () => {
    const h = setupAgent();
    expect(() => h.editor.commitTransaction()).toThrow();
    expect(() => h.editor.rollbackTransaction()).toThrow();
  });

  it("collapses direct editor commands too, leaving one entry spanning the whole range", () => {
    const h = setupAgent();
    const asset = videoAsset("a1", 10);
    const base = h.editor.getState().doc;
    h.editor.beginTransaction("Direct");
    h.editor.execute(insertMediaElement({ asset, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    h.editor.execute(deleteElements([{ trackId: tracksOf(h.editor).main.id, elementId: "c1" }]));
    h.editor.execute(insertMediaElement({ asset, elementId: "c2", startTime: 0, placement: { mode: "auto" } }));
    h.editor.commitTransaction();
    expect(tracksOf(h.editor).main.elements.map((e) => e.id)).toEqual(["c2"]);
    h.editor.undo();
    expect(h.editor.getState().doc).toBe(base);
    expect(h.editor.getState().canUndo).toBe(false);
  });
});

describe("read-only tools", () => {
  it("never touch history, revision or the document", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("insert_text", { text: "hi" });
    h.editor.undo();
    const before = h.editor.getState();
    const tools = createAgentTools();
    const argsFor: Record<string, unknown> = { get_element: { elementId: a.elementId } };
    for (const tool of tools.values()) {
      if (!tool.readOnly) continue;
      const result = await tool.run(argsFor[tool.name] ?? (tool.name === "seek" ? { time: 1 } : tool.name === "select" ? { elementIds: [a.elementId] } : {}), { editor: h.editor, nowMs: () => 0 });
      expect(result.ok, `${tool.name} ${JSON.stringify(result)}`).toBe(true);
    }
    const after = h.editor.getState();
    expect(after.doc).toBe(before.doc);
    expect(after.revision).toBe(before.revision);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(true);
  });
});

describe("runToolTurn", () => {
  const ctxOf = (h: ReturnType<typeof setupAgent>) => ({ editor: h.editor, nowMs: () => 0 });

  it("runs a batch of calls as one undo step", async () => {
    const h = setupAgent();
    const out = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: ctxOf(h), label: "Batch",
      calls: [{ name: "insert_media", args: { assetId: "a1" } }, { name: "insert_media", args: { assetId: "a2" } }, { name: "split", args: { at: 3 } }],
    });
    expect(out.rolledBack).toBe(false);
    expect(out.results.every((r) => r.result.ok)).toBe(true);
    h.editor.undo();
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("atomic turns roll back on the first failure and stop", async () => {
    const h = setupAgent();
    const pre = h.editor.getState().doc;
    const out = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: ctxOf(h), label: "Atomic", atomic: true,
      calls: [{ name: "insert_media", args: { assetId: "a1" } }, { name: "delete", args: { elementIds: ["ghost"] } }, { name: "insert_media", args: { assetId: "a2" } }],
    });
    expect(out.rolledBack).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(h.editor.getState().doc).toBe(pre);
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("non-atomic turns keep the successful calls and report the failure", async () => {
    const h = setupAgent();
    const out = await runToolTurn({
      editor: h.editor, tools: createAgentTools(), ctx: ctxOf(h), label: "Lenient",
      calls: [{ name: "insert_media", args: { assetId: "a1" } }, { name: "nope", args: {} }, { name: "insert_media", args: { assetId: "a2" } }],
    });
    expect(out.results.map((r) => r.result.ok)).toEqual([true, false, true]);
    expect(tracksOf(h.editor).main.elements).toHaveLength(2);
    h.editor.undo();
    expect(tracksOf(h.editor).main.elements).toHaveLength(0);
  });
});
