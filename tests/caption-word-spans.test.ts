import { describe, expect, it } from "vitest";
import { parseAss, parseSrt } from "#/engine/captions";
import { insertElementsOnLanes } from "#/engine/commands";
import { PROJECT_SCHEMA_VERSION } from "#/engine/model";
import { captionElement } from "#/engine/agent/captions";
import { captionCueWords } from "#/engine/agent/tools-transcript";
import { deserializeProject, serializeProject } from "#/engine/persistence";
import { wordsToCaptionChunks } from "#/engine/transcript";
import { allElements } from "#/engine/timeline";
import { makeEditor, sec } from "./helpers";
import { TALK_WORDS, word } from "./transcript-harness";

describe("caption cue word spans", () => {
  it("carries each chunk's per-word source timings unchanged", () => {
    const chunks = wordsToCaptionChunks({ words: TALK_WORDS, maxChars: 40 });
    const cues = chunks.map((chunk) => ({ chunk, words: captionCueWords(TALK_WORDS, chunk) }));

    expect(cues.map((c) => c.words.length)).toEqual([2, 6, 3]);
    expect(cues[0]?.words).toEqual([
      { text: "Hello", startSeconds: 0, endSeconds: 0.4 },
      { text: "there.", startSeconds: 0.5, endSeconds: 0.9 },
    ]);
    for (const { chunk, words } of cues) {
      expect(words[0]?.startSeconds).toBe(chunk.startSeconds);
      expect(words[words.length - 1]?.endSeconds).toBe(chunk.endSeconds);
      expect(words.map((w) => w.text).join(" ")).toBe(chunk.text);
    }
    expect(cues[1]?.words[0]).toEqual({ text: "We", startSeconds: 1.5, endSeconds: 1.7 });
    expect(cues[2]?.words[2]).toEqual({ text: "watching.", startSeconds: 5.7, endSeconds: 6.3 });
  });

  it("uses only text and timing, dropping confidence and blank tokens", () => {
    const words = [{ ...word("Hi", 0, 0.2), confidence: 0.9 }, word(" ", 0.2, 0.3), word("you", 0.3, 0.6)];
    const [chunk] = wordsToCaptionChunks({ words });
    expect(chunk && captionCueWords(words, chunk)).toEqual([
      { text: "Hi", startSeconds: 0, endSeconds: 0.2 },
      { text: "you", startSeconds: 0.3, endSeconds: 0.6 },
    ]);
  });

  it("indexes against the sliced array the chunks were built from", () => {
    const slice = TALK_WORDS.slice(8);
    const chunks = wordsToCaptionChunks({ words: slice });
    expect(chunks[0] && captionCueWords(slice, chunks[0]).map((w) => w.text)).toEqual(["Thanks", "for", "watching."]);
  });

  it("leaves SRT and ASS cues without words", () => {
    const srt = parseSrt("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
    const ass = parseAss("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n");
    expect(srt.cues.length).toBeGreaterThan(0);
    for (const cue of [...srt.cues, ...ass.cues]) expect("words" in cue).toBe(false);
  });

  it("does not change the persisted caption element: word spans never reach the project JSON", () => {
    const chunk = wordsToCaptionChunks({ words: TALK_WORDS, maxChars: 40 })[0];
    if (!chunk) throw new Error("expected a chunk");
    const base = { text: chunk.text, startTime: sec(1), duration: sec(1) };
    const build = (words?: ReturnType<typeof captionCueWords>) => captionElement({
      cue: words ? { ...base, words } : base, index: 0, id: "cap1", canvas: { width: 1920, height: 1080 }, startTime: sec(1), duration: sec(1),
    });
    expect(build(captionCueWords(TALK_WORDS, chunk))).toEqual(build());

    const { editor } = makeEditor();
    editor.execute(insertElementsOnLanes({ elements: [build(captionCueWords(TALK_WORDS, chunk))], index: 0, label: "captions" }));
    const saved = editor.toProject();
    const json = serializeProject(saved);
    expect(json).not.toContain("startSeconds");
    expect(deserializeProject(json)).toEqual(saved);
    expect(allElements(editor.tracks()).some((l) => l.element.id === "cap1")).toBe(true);
    expect(saved.version).toBe(PROJECT_SCHEMA_VERSION);
  });
});
