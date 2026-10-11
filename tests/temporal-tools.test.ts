import { describe, expect, it } from "vitest";
import { createAgentTools } from "#/engine/agent";
import { allElements } from "#/engine/timeline";
import type { InsertedData } from "./agent-harness";
import { snapshotForUndo, assertEditorHealthy } from "./invariants-harness";
import { coverage, playedSource } from "./transcript-harness";
import { makeAnalysis, setupTemporal, spoken, transcriptOf, type TemporalHarness } from "./temporal-harness";

interface FoundMoment {
  assetId: string; startSeconds: number; endSeconds: number; shotIndex: number; text?: string; loudnessDb: number | null; reason: string;
  timeline?: Array<{ elementId: string; startSeconds: number; endSeconds: number }>;
}
interface FindData { moments: FoundMoment[]; truncated: boolean; skipped: string[]; unit: string }
interface CutData { clips: Array<{ elementId: string; assetId: string; sourceStart: number; sourceEnd: number; start: number; end: number }>; durationSeconds: number }

const find = (h: TemporalHarness, args: Record<string, unknown>): Promise<FindData> => h.data<FindData>("find_moments", args);

describe("registry", () => {
  it("is opt-in: the default registry has no temporal tools", () => {
    expect([...createAgentTools().keys()].filter((n) => /footage|moments/.test(n))).toEqual([]);
  });

  it("flags describe_footage and find_moments read-only and cut_to_moments not", () => {
    const { tools } = setupTemporal();
    expect(["describe_footage", "find_moments", "cut_to_moments"].map((n) => tools.get(n)?.readOnly)).toEqual([true, true, false]);
  });
});

describe("describe_footage", () => {
  it("returns a text picture and bounded structured data, including where the asset sits on the timeline", async () => {
    const h = setupTemporal();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const result = await h.call("describe_footage", { assetId: "a1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain("3 shot(s)");
    expect(result.summary).toContain("Times are SOURCE seconds");
    const data = result.data as { shots: { total: number; items: Array<{ loudnessMeanDb: number }> }; onTimeline: Array<{ elementId: string }> };
    expect(data.shots.total).toBe(3);
    expect(data.shots.items[1]?.loudnessMeanDb).toBeCloseTo(-11.2, 1);
    expect(data.onTimeline.map((c) => c.elementId)).toEqual([clip.elementId]);
  });

  it("fails with a hint for unknown assets, images, and assets nothing is known about", async () => {
    const h = setupTemporal();
    expect((await h.failure("describe_footage", { assetId: "nope" })).hint).toContain("list_assets");
    expect((await h.failure("describe_footage", { assetId: "photo" })).error).toContain("image");
    const none = await h.failure("describe_footage", { assetId: "a3" });
    expect(none.error).toContain("no analysis and no transcript");
    expect(none.hint).toContain("analyze_media");
  });

  it("uses a transcript alone when there is no analysis", async () => {
    const h = setupTemporal({ analyses: [], transcripts: [transcriptOf("a2", spoken("Only words here.", 0, 2))] });
    const result = await h.call("describe_footage", { assetId: "a2" });
    expect(result.ok && result.summary).toContain("No audio/video analysis");
  });
});

describe("find_moments", () => {
  it("finds the sentences containing a phrase, in source seconds", async () => {
    const h = setupTemporal();
    const data = await find(h, { assetId: "a1", text: "budget" });
    expect(data.unit).toBe("source seconds");
    expect(data.moments.map((m) => [m.text, m.startSeconds, m.endSeconds, m.shotIndex])).toEqual([
      ["Let us talk about the budget.", 3.2, 4.36, 1], ["The budget is tight.", 5.6, 6.76, 1],
    ]);
    expect(data.moments.every((m) => m.timeline === undefined)).toBe(true);
  });

  it("maps moments onto the timeline through the clip's start, trim and speed", async () => {
    const h = setupTemporal();
    await h.data("insert_media", { assetId: "a3" });
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("set_speed", { elementId: clip.elementId, speed: 2 });
    const data = await find(h, { assetId: "a1", text: "budget" });
    const [first, second] = data.moments;
    expect(first?.timeline).toEqual([{ elementId: clip.elementId, startSeconds: 6 + 3.2 / 2, endSeconds: 6 + 4.36 / 2 }]);
    expect(second?.timeline?.[0]).toMatchObject({ elementId: clip.elementId, startSeconds: 8.8, endSeconds: 9.38 });
  });

  it("omits timeline placements for the part of a moment that a trimmed clip no longer plays", async () => {
    const h = setupTemporal();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("trim", { elementId: clip.elementId, start: 5 });
    const data = await find(h, { assetId: "a1", text: "budget" });
    expect(data.moments[0]?.timeline).toBeUndefined();
    expect(data.moments[1]?.timeline?.[0]).toMatchObject({ elementId: clip.elementId, startSeconds: 0.6, endSeconds: 1.76 });
  });

  it("lists every clip of the asset that plays a moment", async () => {
    const h = setupTemporal();
    await h.data("insert_media", { assetId: "a1" });
    await h.data("insert_media", { assetId: "a1", start: 20 });
    const data = await find(h, { assetId: "a1", shot: 2 });
    expect(data.moments[0]?.timeline).toHaveLength(2);
  });

  it("supports loudness, silence, shot, range, sort and limit filters", async () => {
    const h = setupTemporal();
    expect((await find(h, { assetId: "a1", minLoudnessDb: -15 })).moments.map((m) => m.shotIndex)).toEqual([1]);
    expect((await find(h, { assetId: "a1", silent: true })).moments.map((m) => [m.startSeconds, m.endSeconds])).toEqual([[4.5, 5.5]]);
    expect((await find(h, { assetId: "a1", speaking: true, shot: 2 })).moments.map((m) => m.text)).toEqual(["Thanks for watching."]);
    expect((await find(h, { assetId: "a1", startSeconds: 8 })).moments.map((m) => [m.startSeconds, m.endSeconds])).toEqual([[8, 10]]);
    expect((await find(h, { assetId: "a1", sort: "loudest", limit: 2 })).moments.map((m) => m.shotIndex)).toEqual([1, 2]);
  });

  it("reports truncation when more moments exist than the limit", async () => {
    const h = setupTemporal();
    const data = await find(h, { assetId: "a1", limit: 2 });
    expect(data.moments).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect((await find(h, { assetId: "a1", limit: 3 })).truncated).toBe(false);
  });

  it("searches every asset with allAssets, ranked together, and says which were skipped", async () => {
    const h = setupTemporal({
      analyses: [makeAnalysis(), makeAnalysis({ assetId: "a2", duration: 8, cuts: [4] })],
      transcripts: [transcriptOf("a1", spoken("The budget is here.", 1, 3)), transcriptOf("a2", [...spoken("Budget budget.", 1, 2), ...spoken("The budget again.", 5, 6)])],
    });
    const data = await find(h, { allAssets: true, text: "budget" });
    expect(data.moments.map((m) => [m.assetId, m.text])).toEqual([["a2", "Budget budget."], ["a1", "The budget is here."], ["a2", "The budget again."]]);
    expect(data.skipped).toEqual(["a3", "music"]);
  });

  it("rejects bad calls with a hint", async () => {
    const h = setupTemporal();
    expect((await h.failure("find_moments", {})).error).toContain("exactly one of assetId or allAssets");
    expect((await h.failure("find_moments", { assetId: "a1", allAssets: true })).error).toContain("exactly one");
    expect((await h.failure("find_moments", { assetId: "a1", startSeconds: 5, endSeconds: 5 })).error).toContain("must be after");
    expect((await h.failure("find_moments", { assetId: "a1", shot: 7 })).hint).toContain("0 to 2");
    expect((await h.failure("find_moments", { assetId: "a1", sort: "louder" })).hint).toContain("loudest");
    expect((await h.failure("find_moments", { assetId: "a1", limit: 0 })).error).toContain(">=");
    const noTranscript = setupTemporal({ transcripts: [] });
    expect((await noTranscript.failure("find_moments", { assetId: "a1", text: "budget" })).hint).toContain("transcribe_asset");
  });

  it("never changes the project", async () => {
    const h = setupTemporal();
    await h.data("insert_media", { assetId: "a1" });
    const before = snapshotForUndo(h.editor);
    await find(h, { allAssets: true, text: "budget" });
    await h.call("describe_footage", { assetId: "a1" });
    expect(snapshotForUndo(h.editor)).toBe(before);
  });
});

describe("cut_to_moments", () => {
  const budget = (h: TemporalHarness): Promise<FindData> => find(h, { assetId: "a1", text: "budget", sort: "time" });

  it("places the moments back to back on the main track, in order, trimmed to their source ranges", async () => {
    const h = setupTemporal();
    const { moments } = await budget(h);
    const data = await h.data<CutData>("cut_to_moments", { moments: moments.map((m) => ({ assetId: m.assetId, startSeconds: m.startSeconds, endSeconds: m.endSeconds })) });
    expect(data.clips).toHaveLength(2);
    expect(data.clips[0]?.start).toBe(0);
    expect(data.clips[1]?.start).toBe(data.clips[0]?.end);
    expect(data.durationSeconds).toBeCloseTo(1.16 + 1.16, 1);
    const played = playedSource(h.editor, "a1");
    expect(coverage(played, 3.2, 4.36)).toBeCloseTo(1.16, 1);
    expect(coverage(played, 5.6, 6.76)).toBeCloseTo(1.16, 1);
    expect(coverage(played, 0, 3)).toBe(0);
    assertEditorHealthy(h.editor, "after cut");
  });

  it("keeps the order given, which may differ from source order, and can reuse a range", async () => {
    const h = setupTemporal();
    const data = await h.data<CutData>("cut_to_moments", {
      moments: [{ assetId: "a1", startSeconds: 7, endSeconds: 8 }, { assetId: "a1", startSeconds: 0, endSeconds: 1 }, { assetId: "a1", startSeconds: 7, endSeconds: 8 }],
    });
    expect(data.clips.map((c) => [c.sourceStart, c.start])).toEqual([[7, 0], [0, 1], [7, 2]]);
  });

  it("mixes assets and appends after what is already on the main track", async () => {
    const h = setupTemporal();
    await h.data("insert_media", { assetId: "a3" });
    const data = await h.data<CutData>("cut_to_moments", { moments: [{ assetId: "a2", startSeconds: 1, endSeconds: 3 }, { assetId: "a1", startSeconds: 0, endSeconds: 2 }] });
    expect(data.clips.map((c) => [c.assetId, c.start, c.end])).toEqual([["a2", 6, 8], ["a1", 8, 10]]);
  });

  it("starts at startSeconds when the span after it is free", async () => {
    const h = setupTemporal();
    await h.data("insert_media", { assetId: "a3" });
    const data = await h.data<CutData>("cut_to_moments", { startSeconds: 8, moments: [{ assetId: "a1", startSeconds: 0, endSeconds: 1 }] });
    expect(data.clips[0]).toMatchObject({ start: 8, end: 9 });
  });

  it("is one undo step", async () => {
    const h = setupTemporal();
    const before = snapshotForUndo(h.editor);
    await h.data("cut_to_moments", { moments: [{ assetId: "a1", startSeconds: 1, endSeconds: 2 }, { assetId: "a1", startSeconds: 3, endSeconds: 4 }, { assetId: "a2", startSeconds: 0, endSeconds: 1 }] });
    const after = snapshotForUndo(h.editor);
    expect(h.editor.undo()).toBe(true);
    expect(snapshotForUndo(h.editor)).toBe(before);
    expect(h.editor.redo()).toBe(true);
    expect(snapshotForUndo(h.editor)).toBe(after);
  });

  describe("replace", () => {
    const momentsOf = (...ranges: Array<[number, number]>) => ranges.map(([startSeconds, endSeconds]) => ({ assetId: "a1", startSeconds, endSeconds }));
    const mainIds = (h: TemporalHarness): string[] => h.editor.tracks().main.elements.map((e) => e.id);

    it("swaps the existing main-track clips for the sequence from 0 and reports the whole-timeline duration", async () => {
      const h = setupTemporal();
      const original = await h.data<InsertedData>("insert_media", { assetId: "a3" });
      const data = await h.data<CutData & { timelineDurationSeconds: number; replacedClips: number }>("cut_to_moments", { replace: true, moments: momentsOf([1, 3], [5, 6]) });
      expect(data.replacedClips).toBe(1);
      expect(data.clips.map((c) => [c.start, c.end])).toEqual([[0, 2], [2, 3]]);
      expect(data.timelineDurationSeconds).toBe(3);
      expect(data.durationSeconds).toBe(3);
      expect(mainIds(h)).not.toContain(original.elementId);
      expect(mainIds(h)).toHaveLength(2);
      assertEditorHealthy(h.editor, "after replace");
    });

    it("the default still appends, so the timeline keeps the original and grows", async () => {
      const h = setupTemporal();
      await h.data("insert_media", { assetId: "a3" });
      const data = await h.data<CutData & { replacedClips: number }>("cut_to_moments", { moments: momentsOf([1, 3]) });
      expect(data.replacedClips).toBe(0);
      expect(data.clips[0]?.start).toBe(6);
      expect(data.durationSeconds).toBe(8);
      expect(mainIds(h)).toHaveLength(2);
    });

    it("is one undo step that restores the original clips, and redo reapplies it", async () => {
      const h = setupTemporal();
      await h.data("insert_media", { assetId: "a3" });
      const before = snapshotForUndo(h.editor);
      await h.data("cut_to_moments", { replace: true, moments: momentsOf([1, 2], [3, 4]) });
      const after = snapshotForUndo(h.editor);
      expect(h.editor.undo()).toBe(true);
      expect(snapshotForUndo(h.editor)).toBe(before);
      expect(h.editor.redo()).toBe(true);
      expect(snapshotForUndo(h.editor)).toBe(after);
    });

    it("works on an empty main track and rejects a later startSeconds without changing anything", async () => {
      const h = setupTemporal();
      const data = await h.data<CutData & { replacedClips: number }>("cut_to_moments", { replace: true, moments: momentsOf([1, 2]) });
      expect(data.replacedClips).toBe(0);
      const before = snapshotForUndo(h.editor);
      const failure = await h.failure("cut_to_moments", { replace: true, startSeconds: 4, moments: momentsOf([1, 2]) });
      expect(failure.error).toContain("startSeconds must be 0");
      expect(snapshotForUndo(h.editor)).toBe(before);
    });

    it("keeps the original clips when the new sequence cannot be built", async () => {
      const h = setupTemporal();
      await h.data("insert_media", { assetId: "a3" });
      const before = snapshotForUndo(h.editor);
      await h.failure("cut_to_moments", { replace: true, moments: [{ assetId: "a1", startSeconds: 1, endSeconds: 999 }] });
      expect(snapshotForUndo(h.editor)).toBe(before);
    });

    it("the occupied-span error tells the model about replace", async () => {
      const h = setupTemporal();
      await h.data("insert_media", { assetId: "a3" });
      const failure = await h.failure("cut_to_moments", { startSeconds: 2, moments: momentsOf([0, 1]) });
      expect(failure.hint).toContain("replace:true");
    });

    it("the tool description says when to use replace", () => {
      const description = setupTemporal().tools.get("cut_to_moments")?.description ?? "";
      expect(description).toMatch(/APPENDING IS THE DEFAULT/);
      expect(description).toMatch(/highlight.*replace:true/s);
    });
  });

  it("find_moments then cut_to_moments plays exactly the found sentences", async () => {
    const h = setupTemporal();
    const { moments } = await find(h, { assetId: "a1", speaking: true, sort: "time" });
    await h.data("cut_to_moments", { moments: moments.map(({ assetId, startSeconds, endSeconds }) => ({ assetId, startSeconds, endSeconds })) });
    const played = playedSource(h.editor, "a1");
    for (const m of moments) expect(coverage(played, m.startSeconds, m.endSeconds)).toBeCloseTo(m.endSeconds - m.startSeconds, 1);
    expect(allElements(h.editor.tracks()).length).toBe(moments.length);
  });

  describe("rejects bad input without touching the project", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["no moments", { moments: [] }, /empty/],
      ["unknown asset", { moments: [{ assetId: "ghost", startSeconds: 0, endSeconds: 1 }] }, /no asset/i],
      ["image asset", { moments: [{ assetId: "photo", startSeconds: 0, endSeconds: 1 }] }, /not a video/i],
      ["audio asset", { moments: [{ assetId: "music", startSeconds: 0, endSeconds: 1 }] }, /not a video/i],
      ["reversed range", { moments: [{ assetId: "a1", startSeconds: 3, endSeconds: 2 }] }, /must be after/],
      ["past the source end", { moments: [{ assetId: "a1", startSeconds: 9, endSeconds: 11 }] }, /past the end/],
      ["second moment bad", { moments: [{ assetId: "a1", startSeconds: 0, endSeconds: 1 }, { assetId: "a1", startSeconds: 5, endSeconds: 5 }] }, /Shot 2/],
      ["start on empty main", { startSeconds: 4, moments: [{ assetId: "a1", startSeconds: 0, endSeconds: 1 }] }, /must start at 0/],
      ["too many", { moments: Array.from({ length: 101 }, () => ({ assetId: "a1", startSeconds: 0, endSeconds: 0.5 })) }, /Too many/],
    ];
    for (const [name, args, pattern] of cases) {
      it(name, async () => {
        const h = setupTemporal();
        const before = snapshotForUndo(h.editor);
        const failure = await h.failure("cut_to_moments", args);
        expect(failure.error).toMatch(pattern);
        expect(failure.hint.length).toBeGreaterThan(0);
        expect(snapshotForUndo(h.editor)).toBe(before);
        expect(h.editor.undo()).toBe(false);
      });
    }

    it("occupied main track span", async () => {
      const h = setupTemporal();
      await h.data("insert_media", { assetId: "a3" });
      const before = snapshotForUndo(h.editor);
      const failure = await h.failure("cut_to_moments", { startSeconds: 2, moments: [{ assetId: "a1", startSeconds: 0, endSeconds: 1 }] });
      expect(failure.error).toContain("occupied");
      expect(snapshotForUndo(h.editor)).toBe(before);
    });

    it("a start before the first clip would shift, which rolls back", async () => {
      const h = setupTemporal();
      await h.data("insert_media", { assetId: "a3" });
      await h.data("move", { elementIds: [(allElements(h.editor.tracks())[0]?.element.id) as string], start: 10 });
      const before = snapshotForUndo(h.editor);
      const result = await h.call("cut_to_moments", { startSeconds: 2, moments: [{ assetId: "a1", startSeconds: 0, endSeconds: 1 }, { assetId: "a1", startSeconds: 2, endSeconds: 3 }] });
      if (result.ok) assertEditorHealthy(h.editor, "accepted");
      else expect(snapshotForUndo(h.editor)).toBe(before);
    });
  });
});
