import { describe, expect, it } from "vitest";
import { insertPayload } from "#/app/insert";
import { currentScene } from "#/engine/commands";
import { allElements } from "#/engine/timeline";
import type { DropTarget } from "#/engine/timeline";
import { mediaTime } from "#/engine/time";
import { makeEditor, sec, videoAsset } from "./helpers";

const overlayDrop: DropTarget = { trackIndex: 0, isNewTrack: true, insertPosition: "above", xPosition: sec(1.2), targetElement: null };
const payload = (assetId: string) => ({ kind: "media" as const, assetId, mediaType: "video" as const });

describe("first media clip dropped on an empty timeline", () => {
  it("starts at 0 on the main track regardless of drop position and track", () => {
    const { editor } = makeEditor({ assets: [videoAsset("v1", 7)] });
    expect(insertPayload({ editor, payload: payload("v1"), startTime: sec(1.2), target: overlayDrop })).toEqual({ ok: true });
    const tracks = currentScene(editor.getState().doc).tracks;
    expect(tracks.overlay).toHaveLength(0);
    const placed = allElements(tracks);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.element.startTime).toBe(0);
    expect(tracks.main.elements).toHaveLength(1);
  });

  it("is a single undo step", () => {
    const { editor } = makeEditor({ assets: [videoAsset("v1", 7)] });
    insertPayload({ editor, payload: payload("v1"), startTime: sec(2), target: overlayDrop });
    editor.undo();
    expect(allElements(currentScene(editor.getState().doc).tracks)).toHaveLength(0);
  });

  it("keeps drop-position semantics for later drops", () => {
    const { editor } = makeEditor({ assets: [videoAsset("v1", 7), videoAsset("v2", 2)] });
    insertPayload({ editor, payload: payload("v1"), startTime: sec(1), target: overlayDrop });
    const second: DropTarget = { trackIndex: 0, isNewTrack: true, insertPosition: "above", xPosition: sec(3), targetElement: null };
    insertPayload({ editor, payload: payload("v2"), startTime: sec(3), target: second });
    const tracks = currentScene(editor.getState().doc).tracks;
    expect(tracks.overlay).toHaveLength(1);
    expect(tracks.overlay[0]?.elements[0]?.startTime).toBe(mediaTime(sec(3)));
  });
});
