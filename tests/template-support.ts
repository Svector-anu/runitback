import { assertDocumentInvariants } from "#/engine/timeline";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { parseTemplate, type ProjectTemplate } from "#/engine/templates";
import { makeEditor, sec } from "./helpers";

export interface AssetSpec {
  id: string;
  type: "video" | "image" | "audio";
  seconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

export function assetOf(spec: AssetSpec): MediaAssetInfo {
  const base = { id: spec.id, name: `${spec.id}.${spec.type === "video" ? "mp4" : spec.type === "audio" ? "mp3" : "png"}`, size: 1, lastModified: 0 };
  if (spec.type === "audio") return { ...base, type: "audio", duration: sec(spec.seconds ?? 10) };
  if (spec.type === "image") return { ...base, type: "image", width: spec.width ?? 1280, height: spec.height ?? 720 };
  return { ...base, type: "video", width: spec.width ?? 1920, height: spec.height ?? 1080, duration: sec(spec.seconds ?? 10), hasAudio: spec.hasAudio ?? true };
}

export function editorWith(specs: ReadonlyArray<AssetSpec>): Editor {
  return makeEditor({ assets: specs.map(assetOf) }).editor;
}

export function checkInvariants(editor: Editor): void {
  const { doc } = editor.getState();
  assertDocumentInvariants({ scenes: doc.scenes, currentSceneId: doc.currentSceneId });
}

/** A small valid template for tests; `patch` replaces top-level fields. */
export function sampleTemplate(patch: Record<string, unknown> = {}): ProjectTemplate {
  return parseTemplate({
    format: "runitback-template", templateVersion: 1, id: "sample", name: "Sample", description: "A sample.", category: "launch", tags: ["test"],
    canvas: { aspect: "16:9", fps: 30, backgroundColor: "#101322" }, durationSeconds: 10,
    slots: [
      { id: "clip-a", kind: "video", label: "Clip A", expectedSeconds: 5 },
      { id: "clip-b", kind: "video", label: "Clip B", expectedSeconds: 5 },
      { id: "music", kind: "audio", label: "Music", optional: true },
    ],
    texts: [
      { id: "title", label: "Title", default: "Hello", style: "headline", animation: { in: { preset: "pop" }, out: { preset: "fade" } } },
    ],
    beats: [
      { id: "a", at: 0, duration: 5, media: { slot: "clip-a" }, layers: [{ kind: "text", text: "title", at: 0.5, duration: 3, position: { x: 0, y: 300 } }] },
      { id: "b", at: 5, duration: 5, media: { slot: "clip-b", transitionIn: { type: "dissolve", seconds: 0.6 }, filter: { preset: "warm" } } },
      { id: "m", at: 0, duration: 10, media: { slot: "music" } },
    ],
    ...patch,
  });
}
