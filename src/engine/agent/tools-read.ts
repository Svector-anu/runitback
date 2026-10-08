import { orderedTracks, type TimelineElement } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { frameIndexAt, frameRateToFloat } from "#/engine/time";
import { describeElementFull, gapsOf, summarizeElement } from "./describe";
import { defineTool, ok, toSec, ToolError } from "./env";
import type { AgentTool } from "./types";

const getProject = defineTool<Record<string, never>>({
  name: "get_project",
  description:
    "Project overview: name, canvas size in pixels, frame rate (fps), total duration in seconds, current scene, track count and asset count. Read-only; call first to orient yourself.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  run(_input, env) {
    env.requireProject();
    const { editor } = env;
    const settings = env.doc.settings;
    const tracks = orderedTracks(env.tracks);
    const data = {
      name: editor.getState().meta?.name ?? "",
      canvas: { width: settings.canvasSize.width, height: settings.canvasSize.height },
      fps: Math.round(frameRateToFloat(settings.fps) * 1000) / 1000,
      durationSeconds: toSec(editor.duration()),
      scene: { id: env.scene.id, name: env.scene.name },
      sceneCount: env.doc.scenes.length,
      trackCount: tracks.length,
      assetCount: env.doc.assets.length,
      background: settings.background,
    };
    return ok(`"${data.name}" ${data.canvas.width}x${data.canvas.height} @ ${data.fps} fps, ${data.durationSeconds}s, ${data.trackCount} tracks, ${data.assetCount} assets.`, data);
  },
});

const getTimeline = defineTool<Record<string, never>>({
  name: "get_timeline",
  description:
    "Compact structured view of the whole timeline. Tracks are listed top to bottom (first = drawn on top; the 'main' role track sits below overlays; audio tracks last). Each element has id, type, name, start/end/duration in SECONDS (3 decimals), trimStart (source seconds cut from the head), speed, non-default key params, and hasKeyframes/hasEffects/hasMasks flags. Each track also lists `gaps` (empty spans in seconds before its last element). Read-only.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  run(_input, env) {
    env.requireProject();
    const tracks = orderedTracks(env.tracks).map((track) => {
      const located = allElements(env.tracks).filter((l) => l.track.id === track.id);
      const elements = [...located].sort((a, b) => a.element.startTime - b.element.startTime).map(summarizeElement);
      return {
        id: track.id,
        kind: track.type,
        role: track.id === env.tracks.main.id ? "main" : track.type === "audio" ? "audio" : "overlay",
        name: track.name,
        muted: "muted" in track ? track.muted : undefined,
        hidden: "hidden" in track ? track.hidden : undefined,
        elements,
        gaps: gapsOf(track),
      };
    });
    const elementCount = tracks.reduce((sum, t) => sum + t.elements.length, 0);
    return ok(
      `${tracks.length} tracks, ${elementCount} elements, duration ${toSec(env.editor.duration())}s.`,
      { durationSeconds: toSec(env.editor.duration()), tracks },
    );
  },
});

const getElementTool = defineTool<{ elementId: string }>({
  name: "get_element",
  description:
    "Full detail of one element by id: timing in SECONDS, all params with their real keys, keyframes per animated property (times are seconds from the element start), effects and masks with ids. Read-only.",
  inputSchema: {
    type: "object",
    properties: { elementId: { type: "string", description: "Element id from get_timeline." } },
    required: ["elementId"],
  },
  readOnly: true,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    return ok(`${located.element.type} "${located.element.name}" on track ${located.track.id}.`, describeElementFull(located));
  },
});

const listAssets = defineTool<Record<string, never>>({
  name: "list_assets",
  description:
    "Media assets in the project: id, name, type (video|audio|image), duration in SECONDS (absent for images), width/height in pixels, fps, hasAudio, and whether the asset is already used on any timeline. Use the id with insert_media. Read-only.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  run(_input, env) {
    env.requireProject();
    const used = new Set<string>();
    for (const scene of env.doc.scenes) {
      for (const { element } of allElements(scene.tracks)) {
        if ("mediaId" in element) used.add((element as TimelineElement & { mediaId: string }).mediaId);
      }
    }
    const assets = env.doc.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      durationSeconds: asset.duration === undefined ? undefined : toSec(asset.duration),
      width: asset.width,
      height: asset.height,
      fps: asset.fps ? Math.round(frameRateToFloat(asset.fps) * 1000) / 1000 : undefined,
      hasAudio: asset.hasAudio,
      usedOnTimeline: used.has(asset.id),
    }));
    return ok(`${assets.length} assets (${assets.filter((a) => !a.usedOnTimeline).length} unused).`, { assets });
  },
});

const getSelection = defineTool<Record<string, never>>({
  name: "get_selection",
  description: "The elements currently selected in the editor (ids, types, names). Read-only.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  run(_input, env) {
    env.requireProject();
    const selected = env.editor.selectionRefs().map((ref) => env.locate(ref.elementId)).filter((l) => l !== undefined);
    const elements = selected.map((l) => ({ elementId: l.element.id, trackId: l.track.id, type: l.element.type, name: l.element.name }));
    return ok(elements.length === 0 ? "Nothing is selected." : `${elements.length} element(s) selected.`, { elements });
  },
});

const getPlayhead = defineTool<Record<string, never>>({
  name: "get_playhead",
  description: "Current playhead position in SECONDS (snapped to a frame), its frame number, whether playback is running, and the timeline duration in seconds. Read-only.",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
  run(_input, env) {
    if (!env.editor.hasProject) throw new ToolError("No project is open.", "Open or create a project first.");
    const state = env.editor.playback.getState();
    const data = {
      seconds: toSec(state.currentTime),
      frame: frameIndexAt(state.currentTime, env.fps),
      isPlaying: state.isPlaying,
      durationSeconds: toSec(env.editor.duration()),
    };
    return ok(`Playhead at ${data.seconds}s (frame ${data.frame}).`, data);
  },
});

export const READ_TOOLS: AgentTool[] = [getProject, getTimeline, getElementTool, listAssets, getSelection, getPlayhead];
