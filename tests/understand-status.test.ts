import { describe, expect, it } from "vitest";
import {
  NO_STORED_STAGES, applicableStages, describeStatus, modelStagesToRun, understandStatus, type StoredStages,
} from "#/engine/understand";

const stored = (done: Partial<StoredStages>): StoredStages => ({ ...NO_STORED_STAGES, ...done });

describe("applicableStages", () => {
  it("runs every stage for video with sound", () => {
    expect(applicableStages({ id: "v", type: "video", hasAudio: true })).toEqual(["analysis", "transcript", "visual", "faces"]);
    expect(applicableStages({ id: "v", type: "video" })).toEqual(["analysis", "transcript", "visual", "faces"]);
  });
  it("skips the transcript for silent video, frames for audio, everything for images", () => {
    expect(applicableStages({ id: "v", type: "video", hasAudio: false })).toEqual(["analysis", "visual", "faces"]);
    expect(applicableStages({ id: "a", type: "audio", hasAudio: true })).toEqual(["analysis", "transcript"]);
    expect(applicableStages({ id: "i", type: "image" })).toEqual([]);
  });
});

describe("understandStatus", () => {
  const video = { id: "v", type: "video", hasAudio: true } as const;

  it("is not-understood when nothing is stored", () => {
    const status = understandStatus({ asset: video, stored: NO_STORED_STAGES });
    expect(status.state).toBe("not-understood");
    expect(status.missing).toEqual(["analysis", "transcript", "visual", "faces"]);
    expect(describeStatus(status)).toBe("Not understood");
  });

  it("is partial with the missing stages named, and failures named as the reason", () => {
    const status = understandStatus({ asset: video, stored: stored({ analysis: true, visual: true }) });
    expect(status.state).toBe("partial");
    expect(status.indexed).toEqual(["analysis", "visual"]);
    expect(describeStatus(status)).toBe("Partial: missing transcript, faces");
    expect(describeStatus(status, { transcript: "boom" })).toBe("Partial: transcript failed");
  });

  it("is understood once every applicable stage is stored, ignoring stages that do not apply", () => {
    const silent = understandStatus({ asset: { ...video, hasAudio: false }, stored: stored({ analysis: true, visual: true, faces: true }) });
    expect(silent.state).toBe("understood");
    expect(silent.stages.transcript).toBe("not-applicable");
  });

  it("reports images as not applicable", () => {
    expect(understandStatus({ asset: { id: "i", type: "image" }, stored: NO_STORED_STAGES }).state).toBe("not-applicable");
  });
});

describe("modelStagesToRun", () => {
  it("lists only model-backed stages that are still missing, across assets", () => {
    const a = understandStatus({ asset: { id: "a", type: "video", hasAudio: true }, stored: stored({ transcript: true }) });
    const b = understandStatus({ asset: { id: "b", type: "audio", hasAudio: true }, stored: stored({ analysis: true, transcript: true }) });
    expect(modelStagesToRun([a, b])).toEqual(["visual"]);
    expect(modelStagesToRun([])).toEqual([]);
  });
});
