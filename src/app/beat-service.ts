import { useEffect, useMemo } from "react";
import { currentScene } from "#/engine/commands";
import { beatSourceAssetIds, timelineBeatsFor } from "#/engine/beatsync";
import type { SceneTracks } from "#/engine/model";
import { createAnalysisProvider } from "./agent/reference-wiring";
import { sharedAnalysisStore } from "./agent/platform-tools";
import { useTracks } from "./hooks";
import { getServices } from "./services";
import { Store } from "./store";

export type BeatMarkerStatus = "idle" | "analyzing" | "ready" | "none" | "error";

export interface BeatMarkerState {
  /** Show beat ticks on the ruler. */
  show: boolean;
  status: BeatMarkerStatus;
  /** Beat times on the timeline, seconds. */
  beats: number[];
  message: string;
}

export const beatMarkers = new Store<BeatMarkerState>({ show: false, status: "idle", beats: [], message: "" });

export function toggleBeatMarkers(): void {
  beatMarkers.set((s) => ({ show: !s.show }));
}

/** The analysis source the ruler, the toolbar button and the agent share: cached per asset in IndexedDB. */
export function beatAnalysisProvider() {
  const services = getServices();
  return createAnalysisProvider({ editor: services.editor, runtime: () => services.runtime, analysisStore: sharedAnalysisStore });
}

export async function computeTimelineBeats(tracks: SceneTracks): Promise<number[]> {
  return timelineBeatsFor({ tracks, provider: beatAnalysisProvider() });
}

/** What the beats depend on: which music plays where. Cut edits and video changes leave it alone. */
function audioSignature(tracks: SceneTracks): string {
  const ids = new Set(beatSourceAssetIds(tracks));
  return tracks.audio.filter((t) => !t.muted).flatMap((t) => t.elements.filter((e) => ids.has(e.mediaId)).map((e) => `${e.mediaId}:${e.startTime}:${e.duration}:${e.trimStart}:${"retime" in e ? (e.retime?.rate ?? 1) : 1}`)).join("|");
}

/** Keeps `beatMarkers` current while the ruler shows beats. Mount once, next to the ruler. */
export function useBeatMarkers(): BeatMarkerState {
  const state = beatMarkers.use((s) => s);
  const tracks = useTracks();
  const signature = useMemo(() => audioSignature(tracks), [tracks]);
  useEffect(() => {
    if (!state.show) return undefined;
    if (signature === "") {
      beatMarkers.set({ status: "none", beats: [], message: "Put music on an audio track to see its beats." });
      return undefined;
    }
    let cancelled = false;
    beatMarkers.set({ status: "analyzing", message: "" });
    const doc = getServices().editor.getState().doc;
    computeTimelineBeats(currentScene(doc).tracks).then(
      (beats) => {
        if (cancelled) return;
        beatMarkers.set(beats.length > 0
          ? { status: "ready", beats, message: "" }
          : { status: "none", beats: [], message: "No clear rhythm was found in the music on the timeline." });
      },
      (error: unknown) => {
        if (!cancelled) beatMarkers.set({ status: "error", beats: [], message: error instanceof Error ? error.message : "Beat analysis failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state.show, signature]);
  return state;
}
