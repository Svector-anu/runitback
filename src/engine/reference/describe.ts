import type { StyleProfile } from "./types";

const seconds = (value: number): string => `${Math.round(value * 100) / 100}s`;
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const perMinute = (value: number): string => `${Math.round(value * 10) / 10}`;

function labelled(value: number, edges: [number, number], names: [string, string, string]): string {
  return value < edges[0] ? names[0] : value < edges[1] ? names[1] : names[2];
}

/** Compact English plus numbers for an LLM (about 150-220 tokens). Reports measured facts only. */
export function describeStyleProfile(profile: StyleProfile): string {
  const { shots, cutDensity, beatLock, audio, colour, text } = profile;
  const lines = [
    `Style from ${profile.sourceIds.length} reference(s), ${Math.round(profile.totalSeconds)}s total: ${shots.rhythm}, ${shots.count} shots, ${perMinute(shots.cutsPerMinute)} cuts/min.`,
    `Shot length: median ${seconds(shots.medianSeconds)}, mean ${seconds(shots.meanSeconds)}, p10 ${seconds(shots.p10Seconds)}, p90 ${seconds(shots.p90Seconds)}. Opening shot ${seconds(shots.hookSeconds)}.`,
    `Cuts/min opening ${perMinute(cutDensity.openingPerMinute)}, middle ${perMinute(cutDensity.middlePerMinute)}, end ${perMinute(cutDensity.endPerMinute)} (${cutDensity.trend}).`,
  ];
  if (beatLock.beatsAvailable) {
    const tempo = beatLock.tempoBpm === null ? "" : `, tempo ${Math.round(beatLock.tempoBpm)} bpm`;
    lines.push(`Beat lock: ${percent(beatLock.score)} of ${beatLock.cutsMeasured} cuts within ${Math.round(beatLock.toleranceSeconds * 1000)}ms of a beat${tempo}.`);
  } else {
    lines.push("Beat lock: no beat data in the reference.");
  }
  if (audio) {
    const parts = [`silence ${percent(audio.silenceRatio)}`];
    if (audio.loudnessShape) parts.unshift(`loudness ${audio.loudnessShape}`);
    if (audio.dynamicRangeDb !== null) parts.push(`dynamic range ${Math.round(audio.dynamicRangeDb)}dB`);
    lines.push(`Audio: ${parts.join(", ")}.`);
  }
  if (colour) {
    const look = [
      labelled(colour.brightness, [0.35, 0.65], ["dark", "mid-tone", "bright"]),
      labelled(colour.saturation, [0.25, 0.55], ["muted", "moderately saturated", "vivid"]),
      labelled(colour.contrast, [0.25, 0.5], ["low-contrast", "medium-contrast", "high-contrast"]),
    ];
    lines.push(`Colour: ${look.join(", ")}; palette ${colour.palette.slice(0, 3).join(" ")}.`);
  }
  if (text) lines.push(`Text: ${perMinute(text.clipsPerMinute)} clips/min, ${seconds(text.meanDurationSeconds)} each, on screen ${percent(text.coverage)} of the time.`);
  return lines.join("\n");
}
