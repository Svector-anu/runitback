import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, runAgentTurn, type ToolResult } from "#/engine/agent";
import { createMapAnalysisProvider, createMemoryStyleProfileStore, type StoredStyleProfile, type StyleProfileStore } from "#/engine/reference";
import { elementEnd } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import { ASSETS, tracksOf } from "./agent-harness";
import { syntheticAnalysis } from "./reference-fixtures";
import { makeEditor } from "./helpers";

const REFERENCE_LENGTHS = [0.5, 1, 1, 1.5, 0.5, 1, 1.5, 1, 0.5, 1, 1, 1.5, 0.5, 1, 1.5, 1];

function setup(options: { store?: StyleProfileStore } = {}) {
  const { editor } = makeEditor({ assets: ASSETS });
  const store = options.store ?? createMemoryStyleProfileStore();
  const provider = createMapAnalysisProvider([
    syntheticAnalysis({ assetId: "ref", lengths: REFERENCE_LENGTHS, bpm: 120 }),
    syntheticAnalysis({ assetId: "music", lengths: [30], bpm: 120 }),
  ]);
  const tools = createAgentTools({ reference: { store, provider } });
  const ctx = { editor, nowMs: () => 42 };
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
  return { editor, store, tools, call, data, failure };
}

interface Plan { startSeconds: number; shots: Array<{ assetId: string; in: number; out: number }> }

describe("reference tools: registry and schemas", () => {
  it("registers the six tools with descriptions and object schemas, read-only flags set correctly", () => {
    const { tools } = setup();
    const names = ["save_style_profile", "get_style_profile", "list_style_profiles", "compare_to_style", "plan_cuts_to_style", "apply_cut_plan"];
    for (const name of names) {
      const tool = tools.get(name);
      expect(tool, name).toBeDefined();
      expect(tool?.description.length).toBeGreaterThan(60);
      expect(tool?.inputSchema.type).toBe("object");
    }
    expect(tools.get("apply_cut_plan")?.readOnly).toBe(false);
    expect(tools.get("plan_cuts_to_style")?.readOnly).toBe(true);
    expect(tools.get("compare_to_style")?.readOnly).toBe(true);
    expect(tools.get("apply_cut_plan")?.description).toContain("One undo step");
    expect(tools.get("plan_cuts_to_style")?.description).toContain("Does NOT edit");
    // createAgentTools({ reference }) also registers snap_cuts_to_beat, which shares the reference deps' analysis provider.
    expect(tools.size).toBe(createAgentTools().size + names.length + 1);
  });

  it("is absent unless the app injects dependencies, so existing registries are unchanged", () => {
    const plain = createAgentTools();
    expect(plain.has("save_style_profile")).toBe(false);
    expect(plain.size).toBe(46);
  });
});

describe("profile management", () => {
  it("saves, lists and gets a profile, disambiguating duplicate names", async () => {
    const h = setup();
    const saved = await h.data<{ profileId: string; description: string }>("save_style_profile", { name: "Fast Montage!", assetIds: ["ref"] });
    expect(saved.profileId).toBe("fast-montage");
    expect(saved.description).toContain("Beat lock");
    const second = await h.data<{ profileId: string }>("save_style_profile", { name: "Fast Montage!", assetIds: ["ref"] });
    expect(second.profileId).toBe("fast-montage-2");
    const listed = await h.data<{ profiles: Array<{ profileId: string; rhythm: string }> }>("list_style_profiles");
    expect(listed.profiles.map((p) => p.profileId)).toEqual(["fast-montage", "fast-montage-2"]);
    expect(listed.profiles[0]?.rhythm).toBe("fast-montage");
    const got = await h.data<{ profile: { shots: { count: number } } }>("get_style_profile", { profileId: "fast-montage" });
    expect(got.profile.shots.count).toBe(REFERENCE_LENGTHS.length);
    expect((await h.store.get("fast-montage"))?.createdAtMs).toBe(42);
  });

  it("does not touch the project or history", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "s", assetIds: ["ref"] });
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("fails clearly for unknown ids, missing analyses and empty input", async () => {
    const h = setup();
    expect((await h.failure("get_style_profile", { profileId: "nope" })).hint).toContain("save_style_profile");
    await h.data("save_style_profile", { name: "s", assetIds: ["ref"] });
    expect((await h.failure("get_style_profile", { profileId: "nope" })).hint).toContain("Known profiles: s");
    expect((await h.failure("save_style_profile", { name: "x", assetIds: ["a1"] })).error).toContain('No analysis is available for asset "a1"');
    expect((await h.failure("save_style_profile", { name: "x", assetIds: [] })).error).toContain("empty");
    expect((await h.failure("save_style_profile", { name: "x" })).error).toContain("assetIds");
    expect((await h.failure("list_style_profiles", { bogus: 1 })).error).toContain("Unknown field");
  });

  it("uses the injected store", async () => {
    const saved: StoredStyleProfile[] = [];
    const base = createMemoryStyleProfileStore();
    const h = setup({ store: { save: async (e) => { saved.push(e); await base.save(e); }, get: (id) => base.get(id), list: () => base.list() } });
    await h.data("save_style_profile", { name: "async", assetIds: ["ref"] });
    expect(saved.map((e) => e.id)).toEqual(["async"]);
  });
});

describe("plan and apply", () => {
  it("plans without editing, then applies the plan as one undo step with exact trims", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    const before = h.editor.getState().doc;
    const planned = await h.data<{ plan: Plan; totalSeconds: number; shotCount: number }>("plan_cuts_to_style", {
      profileId: "ref", assetIds: ["a1", "a2"], targetDuration: 12, seed: 7, beatAssetId: "music",
    });
    expect(h.editor.getState().doc).toBe(before);
    expect(planned.totalSeconds).toBeCloseTo(12, 2);
    expect(planned.plan.shots.length).toBe(planned.shotCount);

    const applied = await h.data<{ clips: Array<{ elementId: string; start: number; end: number; assetId: string }> }>("apply_cut_plan", { plan: planned.plan });
    expect(applied.clips).toHaveLength(planned.shotCount);
    const main = tracksOf(h.editor).main.elements;
    expect(main).toHaveLength(planned.shotCount);
    let cursor = 0;
    main.forEach((el, i) => {
      const shot = planned.plan.shots[i]!;
      expect(el.startTime).toBe(cursor);
      expect(el.trimStart / TICKS_PER_SECOND).toBeCloseTo(shot.in, 1);
      expect(el.duration / TICKS_PER_SECOND).toBeCloseTo(shot.out - shot.in, 1);
      expect("sourceDuration" in el && el.trimStart + el.duration + el.trimEnd === el.sourceDuration).toBe(true);
      cursor = elementEnd(el);
    });
    expect(h.editor.duration() / TICKS_PER_SECOND).toBeCloseTo(12, 1);

    h.editor.undo();
    expect(tracksOf(h.editor).main.elements).toHaveLength(0);
    expect(h.editor.getState().canUndo).toBe(false);
  });

  it("apply_cut_plan appends nothing and fails on an occupied main track, but replace:true swaps the clips in one undo step", async () => {
    const h = setup();
    await h.data("insert_media", { assetId: "a1" });
    const plan = { shots: [{ assetId: "a1", in: 1, out: 3 }, { assetId: "a2", in: 0, out: 1 }] };
    const refusal = await h.failure("apply_cut_plan", { plan });
    expect(refusal.hint).toContain("replace:true");
    const before = JSON.stringify(h.editor.getState().doc);
    const applied = await h.data<{ clips: unknown[]; timelineDurationSeconds: number; replacedClips: number }>("apply_cut_plan", { plan, replace: true });
    expect(applied.replacedClips).toBe(1);
    expect(applied.clips).toHaveLength(2);
    expect(applied.timelineDurationSeconds).toBeCloseTo(3, 1);
    expect(tracksOf(h.editor).main.elements).toHaveLength(2);
    h.editor.undo();
    expect(JSON.stringify(h.editor.getState().doc)).toBe(before);
    expect(tracksOf(h.editor).main.elements).toHaveLength(1);
  });

  it("snaps planned cuts to beats when a beat source is given, and says so when not", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    const withBeats = await h.data<{ beatSnapped: boolean; plan: Plan }>("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1", "a2"], targetDuration: 14, beatAssetId: "music" });
    expect(withBeats.beatSnapped).toBe(true);
    let t = 0;
    for (const shot of withBeats.plan.shots.slice(0, -1)) {
      t += shot.out - shot.in;
      expect(Math.abs(t / 0.5 - Math.round(t / 0.5))).toBeLessThan(0.01);
    }
    const result = await h.call("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1"], targetDuration: 6 });
    expect(result.ok && result.summary).toContain("pass beatAssetId");
  });

  it("is deterministic per seed through the tool", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    const args = { profileId: "ref", assetIds: ["a1", "a2", "a3"], targetDuration: 15, seed: 9 };
    expect(await h.data("plan_cuts_to_style", args)).toEqual(await h.data("plan_cuts_to_style", args));
  });

  it("applies after existing main-track content only when startSeconds is past it, and otherwise fails without changes", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    const planned = await h.data<{ plan: Plan }>("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1"], targetDuration: 5, beatAssetId: "music" });
    const pre = await h.call("insert_media", { assetId: "a3" });
    expect(pre.ok).toBe(true);
    const afterInsert = h.editor.getState().doc;
    const blocked = await h.failure("apply_cut_plan", { plan: planned.plan });
    expect(blocked.error).toContain("occupied");
    expect(h.editor.getState().doc).toBe(afterInsert);
    const ok = await h.call("apply_cut_plan", { plan: { ...planned.plan, startSeconds: 6 } });
    expect(ok.ok).toBe(true);
    expect(tracksOf(h.editor).main.elements.length).toBeGreaterThan(2);
  });

  it("rolls back inside a failing turn and validates plan shots", async () => {
    const h = setup();
    const good = { assetId: "a1", in: 0, out: 2 };
    expect((await h.failure("apply_cut_plan", { plan: { shots: [good, { assetId: "a1", in: 9, out: 11 }] } })).error).toContain("past the end");
    expect((await h.failure("apply_cut_plan", { plan: { shots: [{ assetId: "ghost", in: 0, out: 1 }] } })).error).toContain("no asset");
    expect((await h.failure("apply_cut_plan", { plan: { shots: [{ assetId: "music", in: 0, out: 1 }] } })).error).toContain("not a video");
    expect((await h.failure("apply_cut_plan", { plan: { shots: [{ assetId: "a1", in: 3, out: 3 }] } })).error).toContain("after in");
    expect((await h.failure("apply_cut_plan", { plan: { shots: [] } })).error).toContain("empty");
    expect(tracksOf(h.editor).main.elements).toHaveLength(0);
    expect(h.editor.getState().canUndo).toBe(false);

    await runAgentTurn(h.editor, "Turn", async () => {
      await h.data("apply_cut_plan", { plan: { shots: [good, { assetId: "a2", in: 1, out: 3 }] } });
      await h.data("insert_media", { assetId: "a3" });
    });
    expect(tracksOf(h.editor).main.elements).toHaveLength(3);
    h.editor.undo();
    expect(tracksOf(h.editor).main.elements).toHaveLength(0);
  });

  it("fails clearly planning with bad inputs", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    expect((await h.failure("plan_cuts_to_style", { profileId: "ref", assetIds: ["music"] })).error).toContain("not a video");
    expect((await h.failure("plan_cuts_to_style", { profileId: "ref", assetIds: ["zzz"] })).error).toContain("No asset");
    expect((await h.failure("plan_cuts_to_style", { profileId: "ref", assetIds: [] })).error).toContain("empty");
    expect((await h.failure("plan_cuts_to_style", { profileId: "missing", assetIds: ["a1"] })).error).toContain("No style profile");
    expect((await h.failure("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1"], minShot: 3, maxShot: 1 })).error).toContain("maxShot");
    expect((await h.failure("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1"], beatAssetId: "a2" })).error).toContain("No analysis");
    expect((await h.failure("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1"], targetDuration: 0 })).error).toContain(">=");
  });
});

describe("compare_to_style", () => {
  it("reports measurable deltas for the current timeline", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    await h.data("insert_media", { assetId: "a1" });
    await h.data("insert_media", { assetId: "a2" });
    const result = await h.data<{ matchScore: number; deltas: Array<{ metric: string; actual: number; target: number; withinTolerance: boolean; message: string }> }>("compare_to_style", { profileId: "ref" });
    const average = result.deltas.find((d) => d.metric === "averageShotSeconds");
    expect(average?.actual).toBe(9);
    expect(average?.withinTolerance).toBe(false);
    expect(average?.message).toContain("average shot 9s vs target");
    expect(result.matchScore).toBeLessThan(0.5);
  });

  it("improves after applying a planned cut and includes beat lock with music on the timeline", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    await h.data("insert_media", { assetId: "music", start: 0 });
    const planned = await h.data<{ plan: Plan }>("plan_cuts_to_style", { profileId: "ref", assetIds: ["a1", "a2", "a3"], targetDuration: 20, seed: 2 });
    await h.data("apply_cut_plan", { plan: planned.plan });
    const result = await h.data<{ matchScore: number; deltas: Array<{ metric: string; actual: number; withinTolerance: boolean }> }>("compare_to_style", { profileId: "ref" });
    const lock = result.deltas.find((d) => d.metric === "beatLockScore");
    expect(lock).toBeDefined();
    expect(lock?.actual).toBeGreaterThan(0.8);
    expect(result.deltas.find((d) => d.metric === "averageShotSeconds")?.withinTolerance).toBe(true);
    for (const metric of ["averageShotSeconds", "medianShotSeconds", "cutsPerMinute"]) {
      expect(result.deltas.find((d) => d.metric === metric)?.withinTolerance, metric).toBe(true);
    }
  });

  it("fails for an empty timeline or unknown profile", async () => {
    const h = setup();
    await h.data("save_style_profile", { name: "ref", assetIds: ["ref"] });
    expect((await h.failure("compare_to_style", { profileId: "ref" })).error).toContain("no video clips");
    expect((await h.failure("compare_to_style", { profileId: "x" })).error).toContain("No style profile");
  });
});
