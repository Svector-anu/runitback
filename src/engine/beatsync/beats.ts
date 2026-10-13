import { trackInputsFromScene, type MediaAnalysis } from "#/engine/analysis";
import type { SceneTracks } from "#/engine/model";
import { timelineBeats, type AnalysisProvider } from "#/engine/reference";

/** Asset ids of the audible audio-track clips: the music the cuts can be snapped to. */
export function beatSourceAssetIds(tracks: SceneTracks): string[] {
  const inputs = trackInputsFromScene({ ...tracks, audio: tracks.audio.filter((t) => !t.muted) });
  const ids = new Set<string>();
  for (const track of inputs) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips) if (clip.mediaId !== undefined) ids.add(clip.mediaId);
  }
  return [...ids];
}

/** Beat times on the timeline (seconds) from the analyses of the unmuted audio-track clips; empty when none has a rhythm. */
export async function timelineBeatsFor(input: { tracks: SceneTracks; provider: AnalysisProvider }): Promise<number[]> {
  const analyses = new Map<string, MediaAnalysis>();
  for (const id of beatSourceAssetIds(input.tracks)) {
    const analysis = await input.provider.get(id);
    if (analysis) analyses.set(id, analysis);
  }
  const unmuted = { ...input.tracks, audio: input.tracks.audio.filter((t) => !t.muted) };
  return timelineBeats({ tracks: trackInputsFromScene(unmuted), analyses });
}
