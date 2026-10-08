import { describe, expect, it } from "vitest";
import { analyzeTimelinePacing, MEDIA_ANALYSIS_VERSION, type MediaAnalysis, type LoudnessWindow } from "#/engine/analysis";
import { Editor } from "#/engine/editor";
import { MemoryAnalysisStore } from "#/platform/analysis";
import { MediaRuntime } from "#/platform/media-runtime";
import {
  SHEET_MAX_FRAMES, SHEET_MAX_SIDE_PX, SUMMARY_LIMITS, evenlySpacedTimes, resampleLoudness, sheetCellSize, summarizeMediaAnalysis,
  summarizeTimelineAnalysis,
} from "#/app/agent/analysis-summary";
import { toolResultToBlock } from "#/app/agent/loop";
import { redactSecrets } from "#/app/agent/model-client";
import { createPlatformTools } from "#/app/agent/platform-tools";
import { makeEditor } from "./helpers";
import { ASSETS } from "./agent-harness";

function analysis(overrides: Partial<MediaAnalysis> = {}): MediaAnalysis {
  return {
    assetId: "a1", version: MEDIA_ANALYSIS_VERSION, durationSeconds: 30.123456, hasAudio: true, hasVideo: true,
    silences: [], loudness: { peakDb: -1.234, rmsDb: -20.56, integratedApproxDb: -18.04 }, speechLikeRanges: [], onsets: [],
    levelCurve: null, sceneCuts: [], shots: [], notes: [], ...overrides,
  };
}

describe("summarizeMediaAnalysis", () => {
  it("rounds values and caps long lists while reporting what was omitted", () => {
    const many = Array.from({ length: 100 }, (_, i) => i);
    const summary = summarizeMediaAnalysis(analysis({
      silences: many.map((i) => ({ start: i + 0.123456, end: i + 0.7, meanDb: -60.55 })),
      sceneCuts: many.map((i) => ({ time: i * 1.23456, score: 0.9 })),
      onsets: many.map((i) => ({ time: i * 0.5, strength: i / 100 })),
      tempoBpm: 120.04, tempoConfidence: 0.8765,
    }));
    expect(summary.durationSeconds).toBe(30.12);
    expect(summary.silences).toHaveLength(SUMMARY_LIMITS.silences);
    expect(summary.silencesOmitted).toBe(100 - SUMMARY_LIMITS.silences);
    expect(summary.sceneCuts).toHaveLength(SUMMARY_LIMITS.cuts);
    expect(summary.sceneCutsOmitted).toBe(60);
    expect(summary.silences[0]).toEqual({ start: 0.12, end: 0.7, meanDb: -60.5 });
    expect(summary.onsetCount).toBe(100);
    expect(summary.strongestOnsets).toHaveLength(SUMMARY_LIMITS.onsets);
    expect(summary.strongestOnsets[0]).toBeLessThan(summary.strongestOnsets[1] as number);
    expect(summary.tempoBpm).toBe(120);
    expect(summary.loudness?.rmsDb).toBe(-20.6);
  });

  it("stays small for a worst-case analysis", () => {
    const many = Array.from({ length: 5000 }, (_, i) => i);
    const summary = summarizeMediaAnalysis(analysis({
      silences: many.map((i) => ({ start: i, end: i + 1, meanDb: -70 })),
      speechLikeRanges: many.map((i) => ({ start: i, end: i + 1 })),
      sceneCuts: many.map((i) => ({ time: i, score: 1 })),
      shots: many.map((i) => ({ start: i, end: i + 1, motion: "low" as const, motionScore: 0.1, dominantColors: [] })),
      onsets: many.map((i) => ({ time: i, strength: 0.5 })),
    }));
    expect(JSON.stringify(summary).length).toBeLessThan(6000);
  });
});

describe("summarizeTimelineAnalysis", () => {
  const tracks = [
    { id: "main", kind: "video" as const, clips: [{ id: "c1", start: 0, end: 3 }, { id: "c2", start: 3, end: 8 }] },
    { id: "music", kind: "audio" as const, clips: [{ id: "m1", start: 0, end: 6 }] },
  ];

  it("reports pacing and dead air", () => {
    const summary = summarizeTimelineAnalysis({ pacing: analyzeTimelinePacing(tracks), loudness: null });
    expect(summary.durationSeconds).toBe(8);
    expect(summary.averageShotLengthSeconds).toBe(4);
    expect(summary.deadAir.totalSeconds).toBe(0);
    expect(summary.tracks.map((t) => t.trackId)).toEqual(["main", "music"]);
    expect(summary.loudness).toBeNull();
  });

  it("merges long loudness series down to the window cap and flags quiet spans", () => {
    const windows: LoudnessWindow[] = Array.from({ length: 300 }, (_, i) => ({ start: i, end: i + 1, db: i >= 100 && i < 130 ? -50 : -20 }));
    const resampled = resampleLoudness(windows, SUMMARY_LIMITS.loudnessWindows);
    expect(resampled.db.length).toBeLessThanOrEqual(SUMMARY_LIMITS.loudnessWindows);
    expect(resampled.windowSeconds).toBe(4);
    const summary = summarizeTimelineAnalysis({ pacing: analyzeTimelinePacing(tracks), loudness: windows });
    expect(summary.loudness?.maxDb).toBeCloseTo(-20, 0);
    expect(summary.loudness?.quietSpans.length).toBe(1);
    expect(summary.loudness?.quietSpans[0]?.[0]).toBeGreaterThanOrEqual(99);
  });
});

describe("contact sheet geometry", () => {
  it("spaces samples at slice midpoints and clamps the frame count", () => {
    expect(evenlySpacedTimes({ durationSeconds: 10, count: 4 })).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(evenlySpacedTimes({ durationSeconds: 10, count: 99 })).toHaveLength(SHEET_MAX_FRAMES);
    expect(evenlySpacedTimes({ durationSeconds: 10, count: 0 })).toHaveLength(1);
  });

  it.each([
    { canvas: { width: 1920, height: 1080 }, columns: 4, frameCount: 16 },
    { canvas: { width: 1080, height: 1920 }, columns: 2, frameCount: 6 },
    { canvas: { width: 1920, height: 1080 }, columns: 1, frameCount: 1 },
  ])("fits cells in %j within the long-side budget", ({ canvas, columns, frameCount }) => {
    const gap = 4;
    const cell = sheetCellSize({ canvas, columns, frameCount });
    const rows = Math.ceil(frameCount / columns);
    expect(columns * cell.width + (columns + 1) * gap).toBeLessThanOrEqual(SHEET_MAX_SIDE_PX);
    expect(rows * cell.height + (rows + 1) * gap).toBeLessThanOrEqual(SHEET_MAX_SIDE_PX);
    expect(Math.abs(cell.width / cell.height - canvas.width / canvas.height)).toBeLessThan(0.05);
  });
});

describe("toolResultToBlock", () => {
  it("renders summary, data and images for success", () => {
    const block = toolResultToBlock({ id: "t", result: { ok: true, summary: "Rendered", data: { a: 1 }, images: [{ mediaType: "image/jpeg", base64: "AAA", caption: "cap" }] } });
    expect(block.isError).toBe(false);
    expect(block.content[0]).toEqual({ type: "text", text: 'Rendered\n{"a":1}' });
    expect(block.content.map((c) => c.type)).toEqual(["text", "text", "image"]);
  });

  it("marks failures as errors with the hint and truncates huge data", () => {
    expect(toolResultToBlock({ id: "t", result: { ok: false, error: "bad", hint: "fix it" } })).toMatchObject({ isError: true, content: [{ text: "bad\nHint: fix it" }] });
    const big = toolResultToBlock({ id: "t", result: { ok: true, summary: "s", data: { text: "x".repeat(50_000) } } });
    expect((big.content[0] as { text: string }).text.length).toBeLessThan(9000);
  });
});

describe("redactSecrets", () => {
  it("removes key-shaped strings and the exact configured key", () => {
    expect(redactSecrets("bad key sk-ant-api03-abcDEF_123-xyz here")).toBe("bad key [redacted] here");
    expect(redactSecrets("token=custom-secret-value-1", "custom-secret-value-1")).toBe("token=[redacted]");
  });
});

describe("platform tools without a browser", () => {
  const deps = (editor: Editor) => ({ editor, runtime: () => new MediaRuntime(), analysisStore: () => new MemoryAnalysisStore() });

  it("exposes the shared tool set", () => {
    const names = createPlatformTools(deps(makeEditor().editor)).map((t) => t.name);
    expect(names).toEqual(["render_frame", "render_contact_sheet", "analyze_media", "analyze_timeline", "export_project"]);
  });

  it("validates input and project state with model-readable errors", async () => {
    const tools = new Map(createPlatformTools(deps(makeEditor({ assets: ASSETS }).editor)).map((t) => [t.name, t]));
    const run = (name: string, input: unknown) => tools.get(name)?.run(input, { editor: makeEditor().editor, nowMs: () => 0 });

    expect(await run("render_frame", { time: -1 })).toMatchObject({ ok: false });
    expect(await run("render_contact_sheet", { count: 99 })).toMatchObject({ ok: false });
    expect(await run("analyze_media", {})).toMatchObject({ ok: false, error: expect.stringContaining("assetId") });
    const unknown = await run("analyze_media", { assetId: "ghost" });
    expect(unknown).toMatchObject({ ok: false, hint: expect.stringContaining("a1") });
    expect(await run("analyze_timeline", {})).toMatchObject({ ok: false, error: expect.stringContaining("empty") });
    expect(await run("export_project", { format: "avi" })).toMatchObject({ ok: false });
  });

  it("reports a missing project instead of throwing", async () => {
    const editor = new Editor({ newId: () => "x", now: () => "2026-01-01T00:00:00.000Z" });
    const tools = createPlatformTools(deps(editor));
    for (const tool of tools) {
      const input = tool.name === "render_frame" ? { time: 0 } : tool.name === "analyze_media" ? { assetId: "a" } : {};
      expect(await tool.run(input, { editor, nowMs: () => 0 })).toMatchObject({ ok: false });
    }
  });
});
