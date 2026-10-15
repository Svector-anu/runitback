import { describe, expect, it } from "vitest";
import { PARAM } from "#/engine/model";
import { resolveElementParams, allElements } from "#/engine/timeline";
import { sec } from "./helpers";
import type { InsertedData } from "./agent-harness";
import { setupTranscript } from "./transcript-harness";

describe("add_captions_from_transcript highlight", () => {
  async function captions(highlight?: { color?: string; sweep?: boolean }, speed?: number) {
    const h = setupTranscript();
    const { elementId } = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    if (speed !== undefined) await h.data("set_speed", { elementId, speed });
    const data = await h.data<{ captions: Array<{ elementId: string; text: string; start: number }> }>("add_captions_from_transcript", { elementId, maxChars: 40, ...(highlight ? { highlight } : {}) });
    const element = (id: string) => allElements(h.editor.tracks()).find((l) => l.element.id === id)!.element;
    return { h, data, element };
  }

  it("steps highlightWord through the words as they are spoken", async () => {
    const { data, element } = await captions({ color: "#ff8800" });
    const second = element(data.captions[1]!.elementId);
    expect(second.params[PARAM.highlightColor]).toBe("#ff8800");
    expect(second.params[PARAM.highlightSweep]).toBe(false);
    const at = (seconds: number) => resolveElementParams(second, sec(seconds))[PARAM.highlightWord];
    expect(at(0)).toBe(0);
    expect(at(0.25)).toBe(0);
    expect(at(1.1)).toBeGreaterThan(0);
    expect(at(2.5)).toBeGreaterThanOrEqual(at(1.1) as number);
    const last = (second.params[PARAM.content] as string).split(/\s+/).length - 1;
    expect(at(second.duration / 120_000 - 0.01)).toBeLessThanOrEqual(last);
  });

  it("holds -1 before the first word when the caption starts ahead of the speech", async () => {
    const { data, element } = await captions({});
    const first = element(data.captions[0]!.elementId);
    expect(first.params[PARAM.highlightColor]).toBe("#ffd400");
    expect(resolveElementParams(first, 0)[PARAM.highlightWord]).toBe(0);
  });

  it("is off unless requested, and honours sweep and speed", async () => {
    const plain = await captions();
    const el = plain.element(plain.data.captions[0]!.elementId);
    expect(el.animations?.[PARAM.highlightWord]).toBeUndefined();
    expect(el.params[PARAM.highlightColor]).toBeUndefined();
    const swept = await captions({ sweep: true }, 2);
    expect(swept.element(swept.data.captions[0]!.elementId).params[PARAM.highlightSweep]).toBe(true);
  });

  it("rejects a bad colour without changing the timeline", async () => {
    const h = setupTranscript();
    const { elementId } = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const failure = await h.failure("add_captions_from_transcript", { elementId, highlight: { color: "yellow" } });
    expect(failure.hint).toContain("#rrggbb");
    expect(allElements(h.editor.tracks()).filter((l) => l.track.type === "text")).toEqual([]);
  });
});
