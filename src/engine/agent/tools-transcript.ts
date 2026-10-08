import { batch, deleteElements, insertElementsOnLanes, splitCommand } from "#/engine/commands";
import type { TimelineElement } from "#/engine/model";
import { allElements, elementEnd, type LocatedElement } from "#/engine/timeline";
import {
  groupSentences, mapSourceToTimeline, searchTranscript, sourceRangesForWords, wordsToCaptionChunks,
  type Transcriber, type Transcript, type TranscriptStore, type TranscriptWord,
} from "#/engine/transcript";
import { TICKS_PER_SECOND, floorToFrame, frameIndexAt, frameStartTime, mediaTime, type MediaTime } from "#/engine/time";
import { captionElement } from "./captions";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import type { AgentTool, JsonSchema } from "./types";

/** Injected by the app layer: where transcripts live and, optionally, how to make one. */
export interface TranscriptDeps {
  store: TranscriptStore;
  transcriber?: Transcriber;
}

const DEFAULT_MAX_MATCHES = 20;
const DEFAULT_PAD_SECONDS = 0.02;
const MAX_PAD_SECONDS = 1;
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const secondsOf = (ticks: number): number => ticks / TICKS_PER_SECOND;

const ELEMENT_ID: JsonSchema = { type: "string", description: "Video or audio clip id from get_timeline." };
const ASSET_ID: JsonSchema = { type: "string", description: "Asset id from list_assets (source time, no timeline mapping)." };

interface Placed {
  located: LocatedElement;
  element: TimelineElement & { mediaId: string };
  assetId: string;
  rate: number;
  /** Source seconds the clip plays: [from, to). */
  from: number;
  to: number;
  startTicks: number;
  endTicks: number;
  /** Transcript word indices that play in this clip (inclusive); null when none do. */
  visible: { first: number; last: number } | null;
}

/** Speech-bearing clips only: a clip with a mediaId that is video or audio. */
function hasSpeechMedia(element: TimelineElement): element is TimelineElement & { mediaId: string } {
  return (element.type === "video" || element.type === "audio") && "mediaId" in element && typeof element.mediaId === "string";
}

function clipsOfAsset(env: ToolEnv, assetId: string): Array<{ elementId: string; start: number; end: number }> {
  return [...env.tracks.overlay, env.tracks.main, ...env.tracks.audio].flatMap((track) =>
    (track.elements as TimelineElement[]).flatMap((e) => (hasSpeechMedia(e) && e.mediaId === assetId ? [{ elementId: e.id, start: toSec(e.startTime), end: toSec(elementEnd(e)) }] : [])));
}

function toTimelineTicks(placed: Placed, sourceSeconds: number): number {
  return mapSourceToTimeline({
    source: sourceSeconds * TICKS_PER_SECOND, trimStart: placed.element.trimStart, rate: placed.rate, start: placed.startTicks, end: placed.endTicks,
  });
}

function visibleWords(words: ReadonlyArray<TranscriptWord>, from: number, to: number): Placed["visible"] {
  let first = -1;
  let last = -1;
  words.forEach((word, index) => {
    const mid = (word.startSeconds + word.endSeconds) / 2;
    if (mid < from || mid >= to) return;
    if (first < 0) first = index;
    last = index;
  });
  return first < 0 ? null : { first, last };
}

export function createTranscriptTools(deps: TranscriptDeps): AgentTool[] {
  async function requireTranscript(assetId: string): Promise<Transcript> {
    const transcript = await deps.store.get(assetId);
    if (transcript) return transcript;
    throw new ToolError(
      `No transcript exists for asset "${assetId}".`,
      deps.transcriber ? "Call transcribe_asset with this assetId first, then retry." : "Transcripts must be provided by the app; speech cannot be located without one.",
    );
  }

  async function placeClip(env: ToolEnv, elementId: string): Promise<{ transcript: Transcript; placed: Placed }> {
    const located = env.require(elementId);
    const element = located.element;
    if (!hasSpeechMedia(element)) {
      throw new ToolError(`Element "${elementId}" is a ${element.type} clip, which has no spoken words.`, "Pass a video or audio clip id from get_timeline.");
    }
    const transcript = await requireTranscript(element.mediaId);
    const rate = "retime" in element && element.retime ? element.retime.rate : 1;
    const from = secondsOf(element.trimStart);
    const to = from + secondsOf(element.duration) * rate;
    return {
      transcript,
      placed: {
        located, element, assetId: element.mediaId, rate, from, to, startTicks: element.startTime, endTicks: elementEnd(element),
        visible: visibleWords(transcript.words, from, to),
      },
    };
  }

  /** A transcript plus, when an element was given, the placement that maps source time onto the timeline. */
  async function resolve(env: ToolEnv, input: { elementId?: string; assetId?: string }): Promise<{ transcript: Transcript; placed?: Placed }> {
    if ((input.elementId === undefined) === (input.assetId === undefined)) {
      throw new ToolError("Pass exactly one of elementId or assetId.", "Use elementId for a clip on the timeline (timeline seconds), assetId for the raw source (source seconds).");
    }
    if (input.elementId !== undefined) {
      env.requireProject();
      return placeClip(env, input.elementId);
    }
    return { transcript: await requireTranscript(input.assetId as string) };
  }

  /** The words a caller may address: the clip's playing words, or the whole transcript for an asset. */
  function addressable(transcript: Transcript, placed: Placed | undefined): { offset: number; words: TranscriptWord[] } {
    if (!placed) return { offset: 0, words: transcript.words };
    if (!placed.visible) return { offset: 0, words: [] };
    return { offset: placed.visible.first, words: transcript.words.slice(placed.visible.first, placed.visible.last + 1) };
  }

  function timeSpan(placed: Placed | undefined, startSeconds: number, endSeconds: number): { start: number; end: number } {
    if (!placed) return { start: ms(startSeconds), end: ms(endSeconds) };
    return { start: toSec(toTimelineTicks(placed, startSeconds)), end: toSec(toTimelineTicks(placed, endSeconds)) };
  }

  const timeUnit = (placed: Placed | undefined): string => (placed ? "timeline seconds" : "source seconds");

  const transcribe = deps.transcriber
    ? defineTool<{ assetId: string; language?: string; force?: boolean }>({
        name: "transcribe_asset",
        description:
          "Speech-to-text for an asset with word-level timings, saved so get_transcript / search_transcript / delete_spoken_range can use it. Reuses an existing transcript unless force:true. Slow for long media. Does not change the project.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: { type: "string", description: "Asset id from list_assets (video or audio with sound)." },
            language: { type: "string", description: "BCP-47 hint such as 'en'; omit to let the recognizer decide." },
            force: { type: "boolean", description: "Transcribe again even if a transcript exists." },
          },
          required: ["assetId"],
        },
        readOnly: true,
        async run(input, env) {
          env.requireProject();
          const asset = env.editor.getAsset(input.assetId);
          if (!asset) throw new ToolError(`No asset with id "${input.assetId}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
          if ((asset.type !== "video" && asset.type !== "audio") || asset.hasAudio === false) {
            throw new ToolError(`Asset "${input.assetId}" has no audio to transcribe.`, "Pass a video with sound or an audio asset.");
          }
          const existing = input.force ? undefined : await deps.store.get(input.assetId);
          let transcript = existing;
          if (!transcript) {
            try {
              transcript = await (deps.transcriber as Transcriber).transcribe({ assetId: input.assetId, ...(input.language === undefined ? {} : { language: input.language }) });
            } catch (error) {
              const needsConsent = error instanceof Error && error.name === "ConsentRequiredError";
              throw new ToolError(
                needsConsent ? (error as Error).message : `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
                needsConsent ? "Do not retry until the user confirms the download; then call transcribe_asset again." : "Retry once; if it keeps failing, tell the user speech recognition is unavailable.",
              );
            }
            await deps.store.save(transcript);
          }
          const last = transcript.words[transcript.words.length - 1];
          return ok(`${existing ? "Transcript already existed" : "Transcribed"}: ${transcript.words.length} words (${transcript.language}, ${transcript.model}).`, {
            assetId: input.assetId, words: transcript.words.length, language: transcript.language, model: transcript.model,
            endSeconds: last ? ms(last.endSeconds) : 0, cached: existing !== undefined,
          });
        },
      })
    : undefined;

  const get = defineTool<{ elementId?: string; assetId?: string; includeWords?: boolean; pauseSeconds?: number }>({
    name: "get_transcript",
    description:
      "Read the transcript as sentences. With elementId (a clip on the timeline) the times are TIMELINE seconds and only words that play in the clip (after trim and speed) are listed; with assetId they are SOURCE seconds of the whole file. Each sentence has startWord/endWord indices (inclusive, stable across edits, usable in delete_spoken_range) and its text. includeWords:true adds per-word timings. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        elementId: ELEMENT_ID,
        assetId: ASSET_ID,
        includeWords: { type: "boolean", description: "Also return every word with its index and times." },
        pauseSeconds: { type: "number", minimum: 0.1, description: "Silence that also ends a sentence (default 0.8)." },
      },
    },
    readOnly: true,
    async run(input, env) {
      const { transcript, placed } = await resolve(env, input);
      const { offset, words } = addressable(transcript, placed);
      const sentences = groupSentences({ words, ...(input.pauseSeconds === undefined ? {} : { pauseSeconds: input.pauseSeconds }) }).map((s) => ({
        startWord: s.startWord + offset, endWord: s.endWord + offset, text: s.text, ...timeSpan(placed, s.startSeconds, s.endSeconds),
      }));
      const data = {
        assetId: transcript.assetId, ...(placed ? { elementId: placed.element.id } : {}), unit: timeUnit(placed), language: transcript.language,
        sentences,
        ...(input.includeWords ? { words: words.map((w, i) => ({ index: i + offset, text: w.text, ...timeSpan(placed, w.startSeconds, w.endSeconds) })) } : {}),
      };
      return ok(
        words.length === 0
          ? "No spoken words play in this clip."
          : `${sentences.length} sentence(s), ${words.length} words, in ${timeUnit(placed)}.\n${sentences.map((s) => `[${s.startWord}-${s.endWord}] ${s.start}s-${s.end}s ${s.text}`).join("\n")}`,
        data,
      );
    },
  });

  const search = defineTool<{ query: string; elementId?: string; assetId?: string; maxResults?: number }>({
    name: "search_transcript",
    description:
      "Find a word or phrase in the transcript, ignoring case and punctuation. With elementId only words that play in that clip are searched and times are TIMELINE seconds; with assetId the whole file is searched in SOURCE seconds. Each match has startWord/endWord indices (inclusive) for delete_spoken_range. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Word or phrase, e.g. 'we should probably skip this part'." },
        elementId: ELEMENT_ID,
        assetId: ASSET_ID,
        maxResults: { type: "integer", minimum: 1, maximum: 200, description: `Default ${DEFAULT_MAX_MATCHES}.` },
      },
      required: ["query"],
    },
    readOnly: true,
    async run(input, env) {
      const { transcript, placed } = await resolve(env, input);
      const { offset, words } = addressable(transcript, placed);
      const found = searchTranscript({ words, query: input.query, maxResults: input.maxResults ?? DEFAULT_MAX_MATCHES });
      const matches = found.map((m, i) => ({
        occurrence: i + 1, startWord: m.startWord + offset, endWord: m.endWord + offset, text: m.text, ...timeSpan(placed, m.startSeconds, m.endSeconds),
      }));
      if (matches.length === 0) return ok(`No match for "${input.query}".`, { query: input.query, unit: timeUnit(placed), matches });
      return ok(
        `${matches.length} match(es) for "${input.query}" in ${timeUnit(placed)}:\n${matches.map((m) => `#${m.occurrence} words ${m.startWord}-${m.endWord} ${m.start}s-${m.end}s "${m.text}"`).join("\n")}`,
        { query: input.query, unit: timeUnit(placed), ...(placed ? { elementId: placed.element.id } : {}), matches },
      );
    },
  });

  const del = defineTool<{
    elementId: string; phrase?: string; occurrence?: number; startWord?: number; endWord?: number; padSeconds?: number; ripple?: boolean;
  }>({
    name: "delete_spoken_range",
    description:
      "Cut spoken words out of a clip: the time span of the given phrase (or word index range from get_transcript / search_transcript) is split out of the clip and removed, as ONE undo step. The span is widened by padSeconds (default 0.02, never into neighbouring words) and snapped outward to the frame grid. By default the gap stays; ripple:true shifts later clips on that SAME track earlier to close it (other tracks are untouched). Pass `phrase` (add `occurrence`, 1-based, when it occurs more than once) OR startWord[/endWord]. Times in SECONDS.",
    inputSchema: {
      type: "object",
      properties: {
        elementId: ELEMENT_ID,
        phrase: { type: "string", description: "Words to delete, matched ignoring case and punctuation." },
        occurrence: { type: "integer", minimum: 1, description: "Which match of `phrase` (1-based); required when it matches more than once." },
        startWord: { type: "integer", minimum: 0, description: "First word index to delete." },
        endWord: { type: "integer", minimum: 0, description: "Last word index to delete, inclusive (default startWord)." },
        padSeconds: { type: "number", minimum: 0, maximum: MAX_PAD_SECONDS, description: `Extra source seconds removed on both sides (default ${DEFAULT_PAD_SECONDS}).` },
        ripple: { type: "boolean", description: "Close the gap on this clip's track." },
      },
      required: ["elementId"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const hasPhrase = input.phrase !== undefined;
      if (hasPhrase === (input.startWord !== undefined)) {
        throw new ToolError("Pass either `phrase` or `startWord` (with optional endWord), not both and not neither.", "Use search_transcript to find the phrase, then pass its phrase or word indices.");
      }
      const { transcript, placed } = await placeClip(env, input.elementId);
      const { offset, words: playing } = addressable(transcript, placed);

      let startWord: number;
      let endWord: number;
      if (hasPhrase) {
        const matches = searchTranscript({ words: playing, query: input.phrase as string });
        if (matches.length === 0) {
          throw new ToolError(`"${input.phrase}" is not spoken in the part of ${input.elementId} that plays.`, "Call search_transcript with elementId to see what is said, or check the spelling.");
        }
        if (matches.length > 1 && input.occurrence === undefined) {
          const listed = matches.map((m, i) => `#${i + 1} at ${timeSpan(placed, m.startSeconds, m.endSeconds).start}s`).join(", ");
          throw new ToolError(`"${input.phrase}" occurs ${matches.length} times (${listed}).`, "Pass `occurrence` (1-based) to choose one, or use startWord/endWord.");
        }
        const match = matches[(input.occurrence ?? 1) - 1];
        if (!match) throw new ToolError(`There is no occurrence ${input.occurrence} of "${input.phrase}"; found ${matches.length}.`, "Use an occurrence between 1 and the match count.");
        startWord = match.startWord + offset;
        endWord = match.endWord + offset;
      } else {
        startWord = input.startWord as number;
        endWord = input.endWord ?? startWord;
        if (endWord < startWord) throw new ToolError(`endWord ${endWord} is before startWord ${startWord}.`, "Word indices are inclusive and ascending.");
        const last = placed.visible?.last ?? -1;
        const first = placed.visible?.first ?? 0;
        if (!placed.visible || startWord < first || endWord > last) {
          const owners = clipsOfAsset(env, placed.assetId).map((c) => c.elementId).filter((id) => id !== placed.element.id);
          throw new ToolError(
            placed.visible ? `Words ${startWord}-${endWord} are not all inside this clip (it plays words ${first}-${last}).` : "No spoken words play in this clip.",
            owners.length > 0 ? `Other clips of this asset: ${owners.join(", ")}. Use get_transcript with elementId to see each clip's words.` : "Use get_transcript with elementId to see which words this clip plays.",
          );
        }
      }

      const [span] = sourceRangesForWords({
        words: transcript.words,
        ranges: [{ startWord, endWord }],
        padSeconds: input.padSeconds ?? DEFAULT_PAD_SECONDS,
        ...(placed.element.sourceDuration === undefined ? {} : { durationSeconds: secondsOf(placed.element.sourceDuration) }),
      });
      if (!span) throw new ToolError("Those words have no duration in the transcript.", "Choose different words.");

      const fps = env.fps;
      const ceilToFrame = (ticks: number): MediaTime => {
        const floor = floorToFrame(ticks, fps);
        return floor >= ticks ? floor : frameStartTime(frameIndexAt(ticks, fps) + 1, fps);
      };
      const cutStart = Math.max(placed.startTicks, floorToFrame(toTimelineTicks(placed, span.startSeconds), fps));
      const cutEnd = Math.min(placed.endTicks, ceilToFrame(toTimelineTicks(placed, span.endSeconds)));
      if (cutEnd <= cutStart) throw new ToolError("The words fall outside the part of the clip that plays.", "Use get_transcript with elementId to see which words this clip plays.");

      const ref = placed.located.ref;
      const middleId = env.atomically("Delete spoken range", () => {
        let middle = placed.element.id;
        if (cutEnd < placed.endTicks) env.editor.execute(splitCommand({ refs: [ref], splitTime: cutEnd }));
        if (cutStart > placed.startTicks) {
          const before = new Set(allElements(env.tracks).map((l) => l.element.id));
          env.editor.execute(splitCommand({ refs: [ref], splitTime: cutStart }));
          const piece = allElements(env.tracks).find((l) => !before.has(l.element.id) && l.track.id === ref.trackId && l.element.startTime === cutStart)?.element;
          if (!piece) throw new ToolError("The clip could not be split at the start of the words.", "Retry with different words or padSeconds.");
          middle = piece.id;
        }
        const target = env.require(middle);
        const previousRipple = env.editor.getState().rippleEnabled;
        env.editor.setRippleEnabled(input.ripple === true);
        try {
          env.editor.execute(deleteElements([target.ref]));
        } finally {
          env.editor.setRippleEnabled(previousRipple);
        }
        return middle;
      });

      const removedSeconds = toSec(cutEnd - cutStart);
      const text = transcript.words.slice(startWord, endWord + 1).map((w) => w.text).join(" ");
      const remaining = clipsOfAsset(env, placed.assetId);
      return ok(
        `Removed "${text}" (${toSec(cutStart)}s-${toSec(cutEnd)}s, ${removedSeconds}s)${input.ripple ? " and closed the gap" : ""}; timeline is now ${toSec(env.editor.duration())}s.`,
        {
          deletedElementId: middleId, text, startWord, endWord,
          removed: { start: toSec(cutStart), end: toSec(cutEnd), duration: removedSeconds },
          sourceRange: { start: ms(span.startSeconds), end: ms(span.endSeconds) },
          ripple: input.ripple === true, durationSeconds: toSec(env.editor.duration()), remainingClips: remaining,
        },
      );
    },
  });

  const captions = defineTool<{ elementId: string; startWord?: number; endWord?: number; maxChars?: number; maxSeconds?: number }>({
    name: "add_captions_from_transcript",
    description:
      "Create caption text clips from the words a clip plays, timed to the speech on the TIMELINE (trim and speed honoured), on new text track(s) at the top (extra tracks only if captions would overlap). Phrasing breaks at sentence ends, pauses, maxChars and maxSeconds. Optionally limit to startWord..endWord. One undo step. Returns track ids and the caption element ids.",
    inputSchema: {
      type: "object",
      properties: {
        elementId: ELEMENT_ID,
        startWord: { type: "integer", minimum: 0, description: "Only captions from this word index (inclusive)." },
        endWord: { type: "integer", minimum: 0, description: "Only captions up to this word index (inclusive)." },
        maxChars: { type: "integer", minimum: 8, maximum: 120, description: "Longest caption line in characters (default 32)." },
        maxSeconds: { type: "number", minimum: 0.5, maximum: 10, description: "Longest caption in SECONDS (default 3)." },
      },
      required: ["elementId"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const { transcript, placed } = await placeClip(env, input.elementId);
      const { offset, words } = addressable(transcript, placed);
      if (words.length === 0) throw new ToolError("No spoken words play in this clip.", "Pick a clip whose speech is inside its trimmed region.");
      const from = Math.max(0, (input.startWord ?? offset) - offset);
      const to = Math.min(words.length - 1, (input.endWord ?? offset + words.length - 1) - offset);
      if (to < from) throw new ToolError("The word range is outside this clip.", "Use get_transcript with elementId to see the clip's word indices.");
      const chunks = wordsToCaptionChunks({
        words: words.slice(from, to + 1),
        ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
        ...(input.maxSeconds === undefined ? {} : { maxSeconds: input.maxSeconds }),
      });
      const frame = env.snapDuration(0);
      const timed = chunks
        .map((chunk) => ({ chunk, start: env.snapTicks(toTimelineTicks(placed, chunk.startSeconds)), end: env.snapTicks(toTimelineTicks(placed, chunk.endSeconds)) }))
        .sort((a, b) => a.start - b.start);
      const kept = timed.flatMap((entry, i) => {
        const next = timed[i + 1];
        const end = next && next.start < entry.end ? next.start : entry.end;
        return end - entry.start >= frame ? [{ chunk: entry.chunk, start: entry.start, duration: mediaTime(end - entry.start) }] : [];
      });
      if (kept.length === 0) throw new ToolError("Every caption would be shorter than one frame.", "Choose a longer word range.");
      const canvas = env.doc.settings.canvasSize;
      const ids = kept.map(() => env.editor.newId());
      const elements = kept.map((k, i) => captionElement({
        cue: { text: k.chunk.text, startTime: k.start, duration: k.duration }, index: i, id: ids[i] as string, canvas, startTime: k.start, duration: k.duration,
      }));
      env.editor.execute(batch("Add captions from transcript", [insertElementsOnLanes({ elements, index: 0, label: "Add captions from transcript" })]));
      const trackIds = [...new Set(ids.map((id) => env.require(id).track.id))];
      const last = kept[kept.length - 1] as { start: number; duration: number };
      return ok(`Added ${kept.length} caption(s) on ${trackIds.length} track(s).`, {
        count: kept.length, trackIds, elementIds: ids, start: toSec(kept[0]?.start ?? 0), end: toSec(last.start + last.duration),
        skipped: chunks.length - kept.length,
        captions: kept.map((k, i) => ({ elementId: ids[i], text: k.chunk.text, start: toSec(k.start), end: toSec(k.start + k.duration) })),
      });
    },
  });

  return [get, search, del, captions, ...(transcribe ? [transcribe] : [])];
}
