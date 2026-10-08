import { describe, expect, it } from "vitest";
import { ZERO_USAGE } from "#/app/agent/model-client";
import { MEDIA_ANALYSIS_VERSION } from "#/engine/analysis";
import { callTool } from "#/engine/agent";
import type { Project } from "#/engine/model";
import { SRT_CUES, caseById, srtOf } from "../evals/cases";
import { INVARIANT_CHECKS, documentKey, graded, runCheck } from "../evals/checks";
import { analysisFromSpec, complementOf, mergeRanges, truthFromAnalysis, truthFromSpec } from "../evals/fixtures";
import { buildWorld, type World } from "../evals/harness";
import { encodePng } from "../evals/png";
import { DEFAULT_PRICING, buildReport, estimateCostUsd, renderMarkdown } from "../evals/report";
import { audibleSoundRanges, clipsOf, silentRuns, sourceRangesOnTimeline, sourceTimesOnTimeline, type ClipView } from "../evals/timeline";
import type { CheckInput, FixtureSpec, RunSummary } from "../evals/types";

const RUN: RunSummary = { status: "done", finalText: "ok", steps: 1, changed: true, usage: ZERO_USAGE };

type Edit = [string, unknown];

async function worldWith(caseId: string, edits: ReadonlyArray<Edit> = []): Promise<{ world: World; input: CheckInput }> {
  const world = await buildWorld(caseById(caseId));
  const ctx = { editor: world.editor, nowMs: () => 0 };
  for (const [name, args] of edits) {
    const result = await callTool({ tools: world.tools, name, args, ctx });
    if (!result.ok) throw new Error(`${name}: ${result.error}`);
  }
  const final = world.editor.toProject();
  return { world, input: { initial: world.initial, final, afterUndo: final, fixtures: world.fixtures, run: RUN } };
}

const checkOf = (caseId: string, id: string) => {
  const found = caseById(caseId).checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

const splits = (times: number[]): Edit[] => times.map((at): Edit => ["split", { at }]);

describe("fixtures: ground truth from declarations", () => {
  const speech: FixtureSpec = {
    id: "s", name: "s.mp4", kind: "video", durationSeconds: 10,
    audio: { kind: "speech", speech: [{ start: 1, end: 3 }, { start: 2.5, end: 4 }, { start: 8, end: 12 }] },
  };

  it("merges, clamps and complements speech ranges exactly", () => {
    const truth = truthFromSpec(speech);
    expect(truth.sound).toEqual([{ start: 1, end: 4 }, { start: 8, end: 10 }]);
    expect(truth.silences).toEqual([{ start: 0, end: 1 }, { start: 4, end: 8 }]);
    expect(truth.shots).toEqual([{ start: 0, end: 10 }]);
  });

  it("derives beats from tempo and phase and has no silences for music", () => {
    const truth = truthFromSpec({ id: "m", name: "m.mp3", kind: "audio", durationSeconds: 3, audio: { kind: "beat", bpm: 120, phase: 0.25 } });
    expect(truth.beats).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);
    expect(truth.silences).toEqual([]);
  });

  it("silent video has no audio truth at all", () => {
    const truth = truthFromSpec({ id: "v", name: "v.mp4", kind: "video", durationSeconds: 4, audio: { kind: "none" } });
    expect(truth).toMatchObject({ hasAudio: false, sound: [], silences: [] });
  });

  it("builds the analysis a real analyzer would report: silences above the detector minimum, scene cuts, tempo", () => {
    const analysis = analysisFromSpec(speech);
    expect(analysis.version).toBe(MEDIA_ANALYSIS_VERSION);
    expect(analysis.silences.map((s) => [s.start, s.end])).toEqual([[0, 1], [4, 8]]);
    const colored = analysisFromSpec({ id: "c", name: "c.mp4", kind: "video", durationSeconds: 3, audio: { kind: "none" }, blocks: [{ seconds: 1, rgb: [255, 0, 0] }, { seconds: 2, rgb: [0, 0, 255] }] });
    expect(colored.sceneCuts.map((c) => c.time)).toEqual([1]);
    expect(colored.shots.map((s) => s.dominantColors[0])).toEqual(["#ff0000", "#0000ff"]);
    const music = analysisFromSpec({ id: "m", name: "m.mp3", kind: "audio", durationSeconds: 3, audio: { kind: "beat", bpm: 120, phase: 0 } });
    expect(music.tempoBpm).toBe(120);
    expect(music.onsets).toHaveLength(6);
  });

  it("reads truth back from a measured analysis", () => {
    const measured = { ...analysisFromSpec(speech), silences: [{ start: 0, end: 1.03, meanDb: -70 }] };
    const truth = truthFromAnalysis(speech, measured);
    expect(truth.sound).toEqual([{ start: 1.03, end: 10 }]);
  });

  it("range helpers behave at the edges", () => {
    expect(mergeRanges([{ start: 2, end: 3 }, { start: 0, end: 1 }, { start: 1, end: 2 }])).toEqual([{ start: 0, end: 3 }]);
    expect(complementOf([], 5)).toEqual([{ start: 0, end: 5 }]);
    expect(complementOf([{ start: 0, end: 5 }], 5)).toEqual([]);
  });
});

describe("timeline helpers", () => {
  const clip = (over: Partial<ClipView>): ClipView => ({
    id: "c", type: "video", trackId: "t", trackType: "video", lane: "main", name: "c", start: 10, end: 14, duration: 4, trimStart: 2, trimEnd: 0, rate: 2,
    audible: true, params: {}, ...over,
  });

  it("maps source ranges and instants through trim and speed", () => {
    // Plays source [2, 10) at 2x over timeline [10, 14).
    expect(sourceRangesOnTimeline(clip({}), [{ start: 0, end: 4 }, { start: 9, end: 20 }])).toEqual([{ start: 10, end: 11 }, { start: 13.5, end: 14 }]);
    expect(sourceTimesOnTimeline(clip({}), [1, 2, 6, 10])).toEqual([10, 12]);
  });

  it("finds silent runs including dead air before, between and after sound", () => {
    expect(silentRuns({ audible: [{ start: 1, end: 2 }, { start: 4, end: 5 }], end: 7 })).toEqual([{ start: 0, end: 1 }, { start: 2, end: 4 }, { start: 5, end: 7 }]);
    expect(silentRuns({ audible: [{ start: 0, end: 7 }], end: 7 })).toEqual([]);
  });

  it("ignores muted clips when computing audible sound", async () => {
    const { input, world } = await worldWith("remove-silences");
    const clips = clipsOf(input.final);
    expect(audibleSoundRanges({ clips, fixtures: world.fixtures })).toHaveLength(6);
    expect(audibleSoundRanges({ clips: clips.map((c) => ({ ...c, audible: false })), fixtures: world.fixtures })).toEqual([]);
  });
});

describe("task checks", () => {
  it("remove-silences: untouched clip fails, partial removal gets partial credit", async () => {
    const check = checkOf("remove-silences", "no-long-silence");
    const { input } = await worldWith("remove-silences");
    expect(runCheck(check, input)).toMatchObject({ pass: false, score: 0 });
    const partial = await worldWith("remove-silences", [...splits([8, 10.5]), ["delete", { elementIds: ["e-5"], ripple: true }]]);
    const half = runCheck(check, partial.input);
    expect(half.pass).toBe(false);
    expect(half.score).toBeGreaterThan(0.4);
    expect(half.score).toBeLessThan(0.6);
  });

  it("remove-silences: a gap left by a non-rippled delete still counts as silence", async () => {
    const { input } = await worldWith("remove-silences", [...splits([8, 10.5]), ["delete", { elementIds: ["e-5"] }]]);
    expect(runCheck(checkOf("remove-silences", "no-long-silence"), input).pass).toBe(false);
  });

  it("speech-retained passes at 95% and fails below", async () => {
    // Total speech is 23.55 s: losing 0.5 s is 2.1%, losing 2 s is 8.5%.
    const check = checkOf("remove-silences", "speech-retained");
    const slight = await worldWith("remove-silences", [["trim", { elementId: "e-3", end: 29.5 }]]);
    expect(runCheck(check, slight.input).pass).toBe(true);
    const heavy = await worldWith("remove-silences", [["trim", { elementId: "e-3", end: 28 }]]);
    expect(runCheck(check, heavy.input).pass).toBe(false);
  });

  it("trim-to-duration: tolerance is +/- 0.1 s", async () => {
    const check = checkOf("trim-to-duration", "target-duration");
    const exact = await worldWith("trim-to-duration", [["trim", { elementId: "e-3", start: 2 }], ["trim", { elementId: "e-3", end: 8 }]]);
    expect(runCheck(check, exact.input).pass).toBe(true);
    const off = await worldWith("trim-to-duration", [["trim", { elementId: "e-3", start: 2 }], ["trim", { elementId: "e-3", end: 8.5 }]]);
    expect(runCheck(check, off.input).pass).toBe(false);
  });

  it("cut-to-beat: needs enough cuts and rejects cuts between beats", async () => {
    const check = checkOf("cut-to-beat", "cuts-on-beat");
    const footage: Edit = ["insert_media", { assetId: "footage", start: 0 }];
    const none = await worldWith("cut-to-beat", [footage]);
    expect(runCheck(check, none.input).detail).toMatch(/only 0 cut/);
    const onBeat = await worldWith("cut-to-beat", [footage, ...splits([0.75, 1.95, 3.15, 4.35])]);
    expect(runCheck(check, onBeat.input).pass).toBe(true);
    const between = await worldWith("cut-to-beat", [footage, ...splits([1.05, 2.25, 3.45, 4.65])]);
    expect(runCheck(check, between.input)).toMatchObject({ pass: false, score: 0 });
    const mixed = await worldWith("cut-to-beat", [footage, ...splits([0.75, 1.95, 3.15, 4.35, 5.55, 7.05])]);
    expect(runCheck(check, mixed.input).score).toBeCloseTo(5 / 6, 5);
  });

  it("captions-from-srt: matches text ignoring wrapping and case, timing within 50 ms", async () => {
    const check = checkOf("captions-from-srt", "captions-correct");
    const exact = await worldWith("captions-from-srt", [["import_captions", { srt: srtOf(SRT_CUES) }]]);
    expect(runCheck(check, exact.input).pass).toBe(true);
    const shifted = await worldWith("captions-from-srt", [["import_captions", { srt: srtOf(SRT_CUES), offset: 0.2 }]]);
    expect(runCheck(check, shifted.input).pass).toBe(false);
    const reworded = await worldWith("captions-from-srt", [["import_captions", { srt: srtOf(SRT_CUES.map((c, i) => (i === 0 ? { ...c, text: "Welcome back" } : c))) }]]);
    expect(runCheck(check, reworded.input).score).toBeCloseTo(0.75, 5);
  });

  it("title-fade: needs a fade in AND a fade out", async () => {
    const check = checkOf("title-fade", "opacity-fades");
    const edits = (keys: Array<[number, number]>): Edit[] => [
      ["insert_text", { text: "Summer Roadtrip", start: 0, duration: 3 }],
      ...keys.map(([time, value]): Edit => ["add_keyframe", { elementId: "e-5", property: "opacity", time, value }]),
    ];
    const full = await worldWith("title-fade", edits([[0, 0], [0.5, 1], [2.5, 1], [3, 0]]));
    expect(runCheck(check, full.input).pass).toBe(true);
    const fadeInOnly = await worldWith("title-fade", edits([[0, 0], [0.5, 1]]));
    expect(runCheck(check, fadeInOnly.input).pass).toBe(false);
    const flat = await worldWith("title-fade", edits([]));
    expect(runCheck(check, flat.input).pass).toBe(false);
  });

  it("negative cases: the decline pattern accepts questions and refusals, rejects bravado", () => {
    const check = checkOf("ambiguous-request", "asks-or-declines");
    const says = (finalText: string): boolean => runCheck(check, { run: { ...RUN, finalText } } as CheckInput).pass;
    expect(says("What do you mean by better?")).toBe(true);
    expect(says("I can't do that with the tools I have.")).toBe(true);
    expect(says("There is no tool for that, sorry.")).toBe(true);
    expect(says("Done! Made it better.")).toBe(false);
  });

  it("negative cases: any document change fails project-unchanged", async () => {
    const check = checkOf("ambiguous-request", "project-unchanged");
    const untouched = await worldWith("ambiguous-request");
    expect(runCheck(check, { ...untouched.input, run: { ...RUN, changed: false } }).pass).toBe(true);
    const edited = await worldWith("ambiguous-request", [["insert_text", { text: "x", start: 0, duration: 2 }]]);
    expect(runCheck(check, edited.input).pass).toBe(false);
  });
});

describe("invariant checks", () => {
  const byId = (id: string) => {
    const found = INVARIANT_CHECKS.find((c) => c.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  const corrupt = (project: Project, mutate: (element: Record<string, unknown>) => void): Project => {
    const copy = structuredClone(project);
    const scene = copy.scenes.find((s) => s.id === copy.currentSceneId) ?? copy.scenes[0];
    const element = scene?.tracks.main.elements[0];
    if (!element) throw new Error("no element");
    mutate(element as unknown as Record<string, unknown>);
    return copy;
  };

  it("pass on a healthy edited project", async () => {
    const { input } = await worldWith("remove-silences", [["split", { at: 8 }]]);
    for (const check of INVARIANT_CHECKS.filter((c) => c.id !== "undo-restores-original")) expect(runCheck(check, input), check.id).toMatchObject({ pass: true });
  });

  it("detect NaN, negative times and zero durations", async () => {
    const { input } = await worldWith("trim-to-duration");
    expect(runCheck(byId("finite-values"), { ...input, final: corrupt(input.final, (e) => { e["duration"] = NaN; }) }).pass).toBe(false);
    expect(runCheck(byId("non-negative-times"), { ...input, final: corrupt(input.final, (e) => { e["startTime"] = -120_000; }) }).pass).toBe(false);
    expect(runCheck(byId("non-negative-times"), { ...input, final: corrupt(input.final, (e) => { e["duration"] = 0; }) }).pass).toBe(false);
    expect(runCheck(byId("non-negative-times"), { ...input, final: corrupt(input.final, (e) => { e["trimEnd"] = -1; }) }).pass).toBe(false);
  });

  it("detect overlaps on one track", async () => {
    const { input } = await worldWith("reorder-clips");
    const overlapping = structuredClone(input.final);
    const scene = overlapping.scenes.find((s) => s.id === overlapping.currentSceneId) ?? overlapping.scenes[0];
    const second = scene?.tracks.main.elements[1];
    if (!second) throw new Error("no second element");
    second.startTime = (second.startTime - 60_000) as typeof second.startTime;
    expect(runCheck(byId("no-overlaps"), { ...input, final: overlapping }).pass).toBe(false);
  });

  it("detect a broken source mapping", async () => {
    const { input } = await worldWith("trim-to-duration");
    expect(runCheck(byId("source-mapping"), { ...input, final: corrupt(input.final, (e) => { e["trimEnd"] = 5 * 120_000; }) }).pass).toBe(false);
  });

  it("undo-restores-original: true after a transaction is undone, false when the document differs", async () => {
    const { world } = await worldWith("remove-silences");
    const before = world.editor.toProject();
    const ctx = { editor: world.editor, nowMs: () => 0 };
    world.editor.beginTransaction("test");
    await callTool({ tools: world.tools, name: "split", args: { at: 5 }, ctx });
    await callTool({ tools: world.tools, name: "delete", args: { elementIds: ["e-3"] }, ctx });
    world.editor.commitTransaction();
    const final = world.editor.toProject();
    world.editor.undo();
    const afterUndo = world.editor.toProject();
    const input: CheckInput = { initial: before, final, afterUndo, fixtures: world.fixtures, run: RUN };
    expect(runCheck(byId("undo-restores-original"), input).pass).toBe(true);
    expect(runCheck(byId("undo-restores-original"), { ...input, afterUndo: final }).pass).toBe(false);
    expect(documentKey(before)).not.toBe(documentKey(final));
  });

  it("agent-finished fails for every status other than done", () => {
    for (const status of ["error", "max_steps", "token_budget", "aborted", "busy"] as const) {
      expect(runCheck(byId("agent-finished"), { run: { ...RUN, status } } as CheckInput).pass, status).toBe(false);
    }
  });

  it("a check that throws becomes a failure, not a crash", () => {
    const result = runCheck({ id: "boom", description: "", run: () => { throw new Error("nope"); } }, {} as CheckInput);
    expect(result).toMatchObject({ pass: false, score: 0 });
    expect(result.detail).toContain("nope");
  });

  it("graded clamps and applies its threshold", () => {
    expect(graded({ score: 1.5, threshold: 0.8, detail: "" })).toMatchObject({ pass: true, score: 1 });
    expect(graded({ score: 0.79, threshold: 0.8, detail: "" }).pass).toBe(false);
    expect(graded({ score: -1, threshold: 0, detail: "" })).toMatchObject({ pass: true, score: 0 });
  });
});

describe("stub rendering and reports", () => {
  it("encodes a valid PNG (signature, IHDR size, IEND)", () => {
    const png = encodePng({ width: 3, height: 2, pixel: () => [1, 2, 3] });
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(3);
    expect(view.getUint32(20)).toBe(2);
    expect(String.fromCharCode(...png.slice(-8, -4))).toBe("IEND");
  });

  it("render_frame and contact sheets return PNGs captioned with the colours on screen", async () => {
    const { world } = await worldWith("reorder-clips");
    const ctx = { editor: world.editor, nowMs: () => 0 };
    const frame = await callTool({ tools: world.tools, name: "render_frame", args: { time: 5 }, ctx });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(frame.images?.[0]?.mediaType).toBe("image/png");
    expect(frame.images?.[0]?.caption).toContain("#28be50");
    const sheet = await callTool({ tools: world.tools, name: "render_contact_sheet", args: { times: [1, 5, 9] }, ctx });
    expect(sheet.ok && sheet.images?.[0]?.caption).toContain("#dc2828 #28be50 #3250e6");
    expect((await callTool({ tools: world.tools, name: "render_frame", args: { time: -1 }, ctx })).ok).toBe(false);
  });

  it("analyze_media returns the declared ground truth and rejects unknown assets", async () => {
    const { world } = await worldWith("remove-silences");
    const ctx = { editor: world.editor, nowMs: () => 0 };
    const found = await callTool({ tools: world.tools, name: "analyze_media", args: { assetId: "talk" }, ctx });
    expect(found.ok && (found.data as { silences: unknown[] }).silences).toHaveLength(4);
    expect((await callTool({ tools: world.tools, name: "analyze_media", args: { assetId: "nope" }, ctx })).ok).toBe(false);
  });

  it("builds report aggregates and markdown, and prices tokens", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(estimateCostUsd(usage, DEFAULT_PRICING)).toBeCloseTo(3 + 1.5, 6);
    const result = (passed: boolean) => ({
      caseId: "x", policyId: "p", run: { ...RUN, usage, steps: 4 }, outcomes: [{ id: "c1", invariant: false, pass: passed, score: passed ? 1 : 0, detail: "" }],
      score: passed ? 1 : 0, passed, toolCalls: [],
    });
    const report = buildReport({ startedAt: "2026-01-01T00:00:00.000Z", model: "m", pricing: DEFAULT_PRICING, results: [{ caseId: "x", title: "X", trials: [result(true), result(false)] }] });
    expect(report.cases[0]).toMatchObject({ passRate: 0.5, meanScore: 0.5, meanSteps: 4 });
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("| x | 50% | 0.50 | 4.0 |");
    expect(markdown).toContain("failed c1");
  });
});
