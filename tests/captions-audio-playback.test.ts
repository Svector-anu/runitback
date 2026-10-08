import { describe, expect, it } from "vitest";
import { chunkTranscript, parseAss, parseSrt, parseSubtitleFile } from "#/engine/captions";
import { clipGainAt, clipHasAudible, dbToVolumeLine, volumeLineToDb } from "#/engine/audio";
import { Playback } from "#/engine/editor";
import { mediaTime, TICKS_PER_SECOND } from "#/engine/time";
import { upsertKeyframe } from "#/engine/animation";
import { sequentialIds, createTrack } from "#/engine/model";
import { audio, sec, video } from "./helpers";

describe("SRT", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,500\nHello\nworld\n\n2\n00:00:04,5 --> 00:00:05,000\nSecond\n\n3\n00:00:06,000 --> 00:00:05,000\nBackwards\n\n4\n00:00:07,000 --> 00:00:08,000\n\n";
  it("parses cues, joins lines, pads fractional ms, skips invalid", () => {
    const r = parseSrt(srt);
    expect(r.cues).toHaveLength(2);
    expect(r.cues[0]).toMatchObject({ text: "Hello\nworld", startTime: sec(1), duration: sec(2.5) });
    expect(r.cues[1]?.startTime).toBe(sec(4.5));
    expect(r.skipped).toBe(2);
  });
  it("handles CRLF and BOM and cues without an index line", () => {
    const r = parseSrt("﻿00:00:00,000 --> 00:00:01,000\r\nNo index\r\n");
    expect(r.cues).toHaveLength(1);
  });
});

describe("ASS", () => {
  const ass = `[Script Info]
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, Bold, Italic, Underline, StrikeOut, Spacing, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,Arial,54,&H00FF8000,&H80000000,-1,0,0,0,0,3,0,0,8,96,96,54
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\an8}Hello\\Nthere, friend
Comment: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,ignored
Dialogue: 0,0:00:05.00,0:00:04.00,Default,,0,0,0,,backwards
`;
  it("maps style, converts colour ABGR to CSS, strips tags, keeps commas", () => {
    const r = parseAss(ass);
    expect(r.cues).toHaveLength(1);
    const cue = r.cues[0]!;
    expect(cue.text).toBe("Hello\nthere, friend");
    expect(cue.startTime).toBe(sec(1.5));
    expect(cue.style).toMatchObject({ fontFamily: "Arial", fontSizeRatio: 0.05, color: "#0080ff", bold: true, align: "center", vertical: "top" });
    expect(cue.style?.backgroundColor).toMatch(/^#000000/);
    expect(cue.style?.marginVerticalRatio).toBeCloseTo(0.05);
    expect(r.skipped).toBe(1);
    expect(r.warnings.join()).toMatch(/comment/i);
  });
  it("dispatches by extension", () => {
    expect(parseSubtitleFile({ name: "a.SRT", text: "00:00:00,000 --> 00:00:01,000\nx" }).cues).toHaveLength(1);
    expect(() => parseSubtitleFile({ name: "a.vtt", text: "" })).toThrow(/Unsupported/);
  });
});

describe("transcript chunking", () => {
  it("groups three words, enforces min duration, never overlaps", () => {
    const out = chunkTranscript({ segments: [{ text: "one two three four five", start: 0, end: 2 }, { text: "six seven", start: 1, end: 1.5 }] });
    expect(out.map((c) => c.text)).toEqual(["one two three", "four five", "six seven"]);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.start + out[i - 1]!.duration - 1e-9);
    expect(out.every((c) => c.duration >= 0.8)).toBe(true);
  });
});

describe("audio gain", () => {
  const track = createTrack("audio", "a");
  it("0 dB is unity, +20 is 10x, mute and muted tracks are silent", () => {
    const el = audio("s", 0, 5);
    expect(clipGainAt({ element: el, track, localTime: 0 })).toBe(1);
    expect(clipGainAt({ element: { ...el, params: { ...el.params, volume: 20 } }, track, localTime: 0 })).toBeCloseTo(10);
    expect(clipGainAt({ element: { ...el, params: { ...el.params, muted: true } }, track, localTime: 0 })).toBe(0);
    expect(clipGainAt({ element: el, track: { ...track, muted: true }, localTime: 0 })).toBe(0);
  });
  it("-60 dB is quiet but not silent", () => {
    const el = audio("s", 0, 5);
    expect(clipGainAt({ element: { ...el, params: { ...el.params, volume: -60 } }, track, localTime: 0 })).toBeCloseTo(0.001);
    expect(clipGainAt({ element: { ...el, params: { ...el.params, volume: -999 } }, track, localTime: 0 })).toBeCloseTo(0.001);
  });
  it("keyframed volume interpolates in dB", () => {
    let el = audio("s", 0, 5);
    const newId = sequentialIds();
    let animations = upsertKeyframe({ animations: undefined, path: "volume", time: mediaTime(0), value: -20, newId });
    animations = upsertKeyframe({ animations, path: "volume", time: sec(10), value: 0, newId });
    el = { ...el, animations };
    expect(clipGainAt({ element: el, track, localTime: sec(5) })).toBeCloseTo(10 ** (-10 / 20));
  });
  it("source audio of a video can be disabled", () => {
    expect(clipHasAudible(video("v", 0, 1))).toBe(true);
    expect(clipHasAudible(video("v", 0, 1, { isSourceAudioEnabled: false }))).toBe(false);
  });
  it("volume line mapping is monotonic and round-trips to 0.1 dB", () => {
    expect(volumeLineToDb(1)).toBe(-60);
    expect(volumeLineToDb(0)).toBe(20);
    let prev = Infinity;
    for (let f = 0; f <= 1; f += 0.05) {
      const db = volumeLineToDb(f);
      expect(db).toBeLessThanOrEqual(prev);
      prev = db;
    }
    for (const db of [-30, -6, 0, 12]) expect(volumeLineToDb(dbToVolumeLine(db))).toBeCloseTo(db, 0);
  });
});

describe("Playback", () => {
  const fps = { numerator: 30, denominator: 1 };
  function make(duration = sec(10)) {
    let dur = duration;
    const pb = new Playback({ getDuration: () => dur, getFps: () => fps });
    return { pb, setDuration: (d: number) => { dur = mediaTime(d); } };
  }
  it("does not start on an empty timeline", () => {
    const { pb } = make(mediaTime(0));
    pb.play(0);
    expect(pb.getState().isPlaying).toBe(false);
  });
  it("advances with the wall clock on the frame grid and never runs ahead", () => {
    const { pb } = make();
    pb.play(1000);
    pb.tick(1000 + 1016);
    expect(pb.getState().currentTime).toBe(120000);
    pb.tick(1000 + 1040);
    expect(pb.getState().currentTime % 4000).toBe(0);
    expect(pb.getState().currentTime).toBeLessThanOrEqual(Math.round(1.04 * TICKS_PER_SECOND));
  });
  it("stops and clamps at the end; play again restarts from zero", () => {
    const { pb } = make(sec(2));
    pb.play(0);
    pb.tick(5000);
    expect(pb.getState()).toMatchObject({ isPlaying: false, currentTime: sec(2) });
    pb.play(6000);
    expect(pb.getState()).toMatchObject({ isPlaying: true, currentTime: 0 });
  });
  it("seeking while playing re-anchors the clock", () => {
    const { pb } = make();
    pb.play(0);
    pb.seek(sec(5), 2000);
    pb.tick(3000);
    expect(pb.getState().currentTime).toBe(sec(6));
  });
  it("seek clamps to the timeline and snaps to frames", () => {
    const { pb } = make();
    pb.seek(sec(99));
    expect(pb.getState().currentTime).toBe(sec(10));
    pb.seek(-5);
    expect(pb.getState().currentTime).toBe(0);
    pb.seek(2100);
    expect(pb.getState().currentTime).toBe(4000);
  });
  it("notifies seek listeners on play, seek and end", () => {
    const { pb } = make(sec(1));
    const seen: number[] = [];
    pb.onSeek((t) => seen.push(t));
    pb.play(0);
    pb.seek(sec(0.5));
    pb.tick(5000);
    expect(seen).toEqual([0, sec(0.5), sec(1)]);
  });
  it("reconciles after the timeline shrinks and pauses when it empties", () => {
    const { pb, setDuration } = make();
    pb.seek(sec(8));
    setDuration(sec(3));
    pb.reconcile();
    expect(pb.getState().currentTime).toBe(sec(3));
    pb.play(0);
    pb.seek(0);
    setDuration(0);
    pb.reconcile();
    expect(pb.getState().isPlaying).toBe(false);
  });
  it("volume and mute remember the previous level", () => {
    const { pb } = make();
    pb.setVolume(0.4);
    pb.toggleMute();
    expect(pb.getState().muted).toBe(true);
    pb.toggleMute();
    expect(pb.getState()).toMatchObject({ muted: false, volume: 0.4 });
    pb.setVolume(0);
    expect(pb.getState().muted).toBe(true);
    pb.toggleMute();
    expect(pb.getState().volume).toBe(0.4);
  });
});
