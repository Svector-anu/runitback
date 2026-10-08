import { describe, expect, it } from "vitest";
import { MissingMediaError, exportProject, findMissingMedia } from "#/export/exporter";
import { DEFAULT_EXPORT_OPTIONS } from "#/export/plan";
import { insertMediaElement } from "#/engine/commands";
import { makeEditor, videoAsset } from "./helpers";

function editorWithClip() {
  const asset = videoAsset("v1");
  const { editor } = makeEditor({ assets: [asset] });
  editor.execute(insertMediaElement({ asset, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
  return editor;
}

describe("P0-6 export with missing media", () => {
  it("finds clips whose bytes are absent", () => {
    const doc = editorWithClip().getState().doc;
    expect(findMissingMedia(doc, () => undefined)).toEqual(["v1.mp4"]);
    expect(findMissingMedia(doc, () => new Blob(["x"]))).toEqual([]);
  });

  it("rejects instead of rendering black frames", async () => {
    const doc = editorWithClip().getState().doc;
    await expect(exportProject({ doc, getBlob: () => undefined, options: DEFAULT_EXPORT_OPTIONS }))
      .rejects.toBeInstanceOf(MissingMediaError);
  });
});
