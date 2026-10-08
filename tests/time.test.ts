import { describe, expect, it } from "vitest";
import {
  TICKS_PER_SECOND, mediaTime, roundMediaTime, mediaTimeFromSeconds, toSeconds,
  exactTicksPerFrame, frameRateFromFloat, frameDuration, roundToFrame, floorToFrame,
  snappedSeekTime, lastFrameTime, formatTimecode, parseTimecode, isSameFrameRate, frameStartTime,
} from "#/engine/time";

const r = (n: number, d = 1) => ({ numerator: n, denominator: d });

describe("MediaTime", () => {
  it("rejects fractional ticks", () => {
    expect(() => mediaTime(1.5)).toThrow(RangeError);
    expect(mediaTime(7)).toBe(7);
  });
  it("rounds half away from zero symmetrically", () => {
    expect(roundMediaTime(2.5)).toBe(3);
    expect(roundMediaTime(-2.5)).toBe(-3);
    expect(roundMediaTime(2.4)).toBe(2);
  });
  it("converts seconds both ways", () => {
    expect(mediaTimeFromSeconds(1.5)).toBe(1.5 * TICKS_PER_SECOND);
    expect(toSeconds(TICKS_PER_SECOND * 2)).toBe(2);
  });
  it("throws on non-finite", () => {
    expect(() => roundMediaTime(Infinity)).toThrow();
  });
});

describe("FrameRate", () => {
  it.each([
    [r(24), 5000], [r(25), 4800], [r(30), 4000], [r(60), 2000], [r(120), 1000],
    [r(24000, 1001), 5005], [r(30000, 1001), 4004], [r(60000, 1001), 2002],
  ])("ticks per frame %o => %i", (rate, ticks) => {
    expect(exactTicksPerFrame(rate)).toBe(ticks);
    expect(frameDuration(rate)).toBe(ticks);
  });
  it("returns null for rates that do not divide the tick grid", () => {
    expect(exactTicksPerFrame(r(7))).toBeNull();
  });
  it("normalizes common float fps to rational NTSC rates instead of rounding 29.97 to 30", () => {
    expect(frameRateFromFloat(29.97)).toEqual(r(30000, 1001));
    expect(frameRateFromFloat(23.976)).toEqual(r(24000, 1001));
    expect(frameRateFromFloat(30)).toEqual(r(30));
    expect(isSameFrameRate(r(60), r(120, 2))).toBe(true);
  });
  it("snaps to the frame grid, ties up", () => {
    expect(roundToFrame(1999, r(30))).toBe(0);
    expect(roundToFrame(2000, r(30))).toBe(4000);
    
    expect(roundToFrame(6000, r(30))).toBe(8000);
    expect(floorToFrame(7999, r(30))).toBe(4000);
  });
  it("snaps even for non-dividing rates, staying on integer ticks", () => {
    const t = roundToFrame(100_000, r(7));
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBe(frameStartTime(6, r(7)));
  });
  it("snappedSeekTime clamps and may land on duration", () => {
    const fps = r(5);
    const duration = 10 * TICKS_PER_SECOND;
    expect(snappedSeekTime(duration, duration, fps)).toBe(duration);
    expect(snappedSeekTime(duration + 5000, duration, fps)).toBe(duration);
    expect(snappedSeekTime(-100, duration, fps)).toBe(0);
  });
  it("lastFrameTime is the last frame start before the end", () => {
    expect(lastFrameTime(10 * TICKS_PER_SECOND, r(5))).toBe(9.8 * TICKS_PER_SECOND);
    expect(lastFrameTime(0, r(30))).toBe(0);
  });
  it("formats and parses timecode", () => {
    const fps = r(30);
    const t = frameStartTime(30 * 61 + 12, fps);
    expect(formatTimecode(t, fps)).toBe("00:01:01:12");
    expect(parseTimecode("00:01:01:12", fps)).toBe(t);
    expect(parseTimecode("1:12", fps)).toBe(frameStartTime(42, fps));
    expect(parseTimecode("abc", fps)).toBeNull();
  });
});
