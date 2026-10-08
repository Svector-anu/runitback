import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_VERSION, type Transcript } from "#/engine/transcript";
import { IdbTranscriptStore, TRANSCRIPT_DB_NAME } from "#/platform/transcribe";

const transcript = (assetId: string, text = "hello"): Transcript => ({
  version: TRANSCRIPT_VERSION, assetId, language: "en", model: "whisper-tiny.en", words: [{ text, startSeconds: 0, endSeconds: 0.5 }],
});

describe("IdbTranscriptStore", () => {
  it("round-trips a transcript by asset id and misses cleanly", async () => {
    const store = new IdbTranscriptStore(new IDBFactory());
    await store.save(transcript("a1"));
    expect(await store.get("a1")).toEqual(transcript("a1"));
    expect(await store.get("nope")).toBeUndefined();
  });

  it("overwrites the transcript of the same asset and deletes", async () => {
    const store = new IdbTranscriptStore(new IDBFactory());
    await store.save(transcript("a1", "first"));
    await store.save(transcript("a1", "second"));
    expect((await store.get("a1"))?.words[0]?.text).toBe("second");
    await store.delete("a1");
    expect(await store.get("a1")).toBeUndefined();
  });

  it("persists across store instances on the same factory, in the documented database", async () => {
    const factory = new IDBFactory();
    await new IdbTranscriptStore(factory).save(transcript("a1"));
    expect(await new IdbTranscriptStore(factory).get("a1")).toBeDefined();
    const names = (await factory.databases()).map((d) => d.name);
    expect(names).toContain(TRANSCRIPT_DB_NAME);
    expect(TRANSCRIPT_DB_NAME).toBe("runitback-transcripts");
  });
});
