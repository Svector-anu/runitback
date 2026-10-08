import { describe, expect, it } from "vitest";
import { collectAudioClips, gainEnvelope, sourceWindow } from "#/engine/audio";
import { upsertKeyframe } from "#/engine/animation";
import { sequentialIds } from "#/engine/model";
import { mediaTime } from "#/engine/time";
import { audio, sec, tracksWith, video, videoAsset } from "./helpers";

describe("collectAudioClips", () => {
  const assetOf = (id: string, hasAudio = true) => ({ ...videoAsset(id), hasAudio });
  it("collects audio elements and videos with source audio, skipping muted, extracted and silent media", () => {
    const tracks = tracksWith({
      main: [video("v1", 0, 4), video("v2", 4, 4, { isSourceAudioEnabled: false }), video("v3", 8, 4), video("v4", 12, 4, { params: { muted: true } })],
      audio: [{ id: "a1", elements: [audio("s1", 0, 5)] }],
    });
    const clips = collectAudioClips({ tracks, assets: [assetOf("asset-v1"), assetOf("asset-v2"), assetOf("asset-v3", false), assetOf("asset-v4")] });
    expect(clips.map((c) => c.key.split("/")[1]).sort()).toEqual(["s1", "v1"]);
  });
  it("muted tracks contribute nothing", () => {
    const tracks = tracksWith({ audio: [{ id: "a1", elements: [audio("s1", 0, 5)] }] });
    const muted = { ...tracks, audio: tracks.audio.map((t) => ({ ...t, muted: true })) };
    expect(collectAudioClips({ tracks: muted, assets: [] })).toHaveLength(0);
  });
  it("carries trim, rate and pitch flag in seconds", () => {
    const tracks = tracksWith({ main: [video("v1", 2, 5, { trimStart: sec(1), retime: { rate: 2, maintainPitch: true } })] });
    const [clip] = collectAudioClips({ tracks, assets: [assetOf("asset-v1")] });
    expect(clip).toMatchObject({ start: 2, duration: 5, trimStart: 1, rate: 2, maintainPitch: true });
  });
});

describe("gain envelope and source windows", () => {
  it("constant gain yields one point; keyframed volume samples across the window", () => {
    const tracks = tracksWith({ audio: [{ id: "a", elements: [audio("s", 0, 2)] }] });
    const [flat] = collectAudioClips({ tracks, assets: [] });
    expect(gainEnvelope({ clip: flat!, from: 0, to: 2 })).toEqual([{ time: 0, gain: 1 }]);

    const newId = sequentialIds();
    let animations = upsertKeyframe({ animations: undefined, path: "volume", time: mediaTime(0), value: -60, newId });
    animations = upsertKeyframe({ animations, path: "volume", time: sec(2), value: 0, newId });
    const animatedTracks = tracksWith({ audio: [{ id: "a", elements: [{ ...audio("s", 0, 2), animations }] }] });
    const [clip] = collectAudioClips({ tracks: animatedTracks, assets: [] });
    const env = gainEnvelope({ clip: clip!, from: 0, to: 2, step: 0.5 });
    expect(env.map((p) => p.time)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(env[0]!.gain).toBeCloseTo(0.001);
    expect(env[4]!.gain).toBeCloseTo(1);
    expect(env[2]!.gain).toBeGreaterThan(env[1]!.gain);
  });
  it("windows map timeline spans to source spans through trim and speed", () => {
    const tracks = tracksWith({ main: [video("v", 10, 8, { trimStart: sec(3), retime: { rate: 2 } })] });
    const [clip] = collectAudioClips({ tracks, assets: [{ ...videoAsset("asset-v"), hasAudio: true }] });
    expect(sourceWindow({ clip: clip!, from: 12, to: 14 })).toEqual({ start: 3 + 2 * 2, end: 3 + 4 * 2, timelineStart: 12, timelineEnd: 14 });
    expect(sourceWindow({ clip: clip!, from: 0, to: 10 })).toBeNull();
    expect(sourceWindow({ clip: clip!, from: 5, to: 11 })).toMatchObject({ start: 3, end: 5, timelineStart: 10 });
    expect(sourceWindow({ clip: clip!, from: 17, to: 30 })).toMatchObject({ timelineEnd: 18 });
  });
});
