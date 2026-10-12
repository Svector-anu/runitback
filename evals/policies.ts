import {
  ScriptedModelClient, type AssistantBlock, type ModelRequest, type ScriptedTurn, type ToolResultBlock, type ToolUseBlock,
} from "#/app/agent/model-client";

/**
 * Scripted policies: deterministic stand-ins for a model. An ORACLE solves a case through the real tools and must
 * pass every check; a MUTATION is a plausible-but-wrong solution and must fail the checks it is declared to break.
 *
 * Policies never read fixture ground truth. They decide from tool results (list_assets, analyze_media, get_timeline),
 * exactly as a model would, so the same policies drive real decoded media in the browser.
 */

export interface SeenResult {
  name: string;
  ok: boolean;
  text: string;
  data: unknown;
}

export interface Seen {
  /** The user's request. */
  brief: string;
  /** Results of the tool calls from the previous turn, in call order. */
  results: SeenResult[];
  /** Parsed `data` of the first successful result of a tool in the previous turn. */
  data<T>(name: string): T;
}

type Use = (name: string, input?: unknown) => ToolUseBlock;
type Turn = (seen: Seen, use: Use) => AssistantBlock[];

export interface Policy {
  id: string;
  caseId: string;
  kind: "oracle" | "mutation";
  description: string;
  /** Checks that must report a failure when this policy runs. Empty for oracles. */
  mustFail: string[];
  build(): ScriptedModelClient;
}

const say = (text: string): AssistantBlock => ({ type: "text", text });

function parseData(text: string): unknown {
  const line = text.split("\n").reverse().find((l) => l.startsWith("{") || l.startsWith("["));
  if (!line) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function seenOf(request: ModelRequest): Seen {
  const first = request.messages[0];
  const briefBlock = first?.role === "user" ? first.content[0] : undefined;
  const brief = briefBlock?.type === "text" ? briefBlock.text : "";
  const last = request.messages[request.messages.length - 1];
  const previous = request.messages[request.messages.length - 2];
  const results: SeenResult[] = [];
  if (last?.role === "user" && previous?.role === "assistant") {
    const names = new Map(previous.content.flatMap((b) => (b.type === "tool_use" ? [[b.id, b.name] as const] : [])));
    for (const block of last.content) {
      if (block.type !== "tool_result") continue;
      const text = (block as ToolResultBlock).content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      results.push({ name: names.get(block.toolUseId) ?? "?", ok: !block.isError, text, data: parseData(text) });
    }
  }
  return {
    brief,
    results,
    data<T>(name: string): T {
      const hit = results.find((r) => r.name === name && r.ok && r.data !== undefined);
      if (!hit) throw new Error(`policy expected data from ${name}, got: ${results.map((r) => `${r.name}:${r.ok ? "ok" : r.text.slice(0, 80)}`).join(" | ") || "nothing"}`);
      return hit.data as T;
    },
  };
}

/** Builds a client whose n-th response is `turns[n]` evaluated against the tool results of the previous turn. */
function scripted(turns: ReadonlyArray<Turn>): ScriptedModelClient {
  let counter = 0;
  const use: Use = (name, input = {}) => ({ type: "tool_use", id: `call-${++counter}`, name, input });
  const wrapped: ScriptedTurn[] = turns.map((turn) => (request) => ({ content: turn(seenOf(request), use) }));
  return new ScriptedModelClient(wrapped);
}

// Shapes of the tool results the policies read ---------------------------------------------------------------

interface AssetRow { id: string; name: string; durationSeconds?: number }
interface TimelineElement { id: string; type: string; name: string; trackId: string; start: number; end: number; duration: number; assetId?: string }
interface TimelineData { durationSeconds: number; tracks: Array<{ id: string; role?: string; elements: TimelineElement[] }> }
interface AnalysisData { silences: Array<{ start: number; end: number }>; strongestOnsets: number[]; tempoBpm?: number; durationSeconds: number }

const assetNamed = (seen: Seen, name: string): AssetRow => {
  const found = seen.data<{ assets: AssetRow[] }>("list_assets").assets.find((a) => a.name === name);
  if (!found) throw new Error(`policy: asset "${name}" not found`);
  return found;
};
const elementsOf = (timeline: TimelineData): TimelineElement[] => timeline.tracks.flatMap((t) => t.elements);
const orient = (use: Use): AssistantBlock[] => [say("Looking at the project first."), use("list_assets"), use("get_timeline")];
const onlyElement = (seen: Seen): TimelineElement => {
  const [element] = elementsOf(seen.data<TimelineData>("get_timeline"));
  if (!element) throw new Error("policy: the timeline is empty");
  return element;
};

// Oracles and mutations --------------------------------------------------------------------------------------------

const MAX_KEPT_SILENCE = 0.5;
const SILENCE_EDGE_SLACK = 0.04;
const DELETE_EVERYTHING: Turn[] = [
  (_seen, use) => [say("Starting from the timeline."), use("get_timeline")],
  (seen, use) => [use("delete", { elementIds: elementsOf(seen.data<TimelineData>("get_timeline")).map((e) => e.id), ripple: true })],
  () => [say("Tidied up: the timeline is clean now.")],
];
const SAYS_DONE: Turn[] = [() => [say("All done, the video is ready.")]];

/** Splits at every long-silence edge (moved outward by `pad`), then deletes the pieces that lie inside. */
function removeSilences(options: { ripple: boolean; pad: number }): () => Turn[] {
  return () => {
    let ranges: Array<{ start: number; end: number }> = [];
    return [
      (_seen, use) => orient(use),
      (seen, use) => [use("analyze_media", { assetId: assetNamed(seen, "talk.mp4").id })],
      (seen, use) => {
        ranges = seen.data<AnalysisData>("analyze_media").silences.filter((s) => s.end - s.start > MAX_KEPT_SILENCE);
        const cuts = ranges.flatMap((s) => [s.start - options.pad, s.end + options.pad]).map((at) => use("split", { at }));
        return [say(`Cutting at the edges of ${ranges.length} long silences.`), ...cuts, use("get_timeline")];
      },
      (seen, use) => {
        const pieces = elementsOf(seen.data<TimelineData>("get_timeline")).filter((e) =>
          ranges.some((s) => e.start >= s.start - options.pad - SILENCE_EDGE_SLACK && e.end <= s.end + options.pad + SILENCE_EDGE_SLACK));
        return [use("delete", { elementIds: pieces.map((e) => e.id), ripple: options.ripple })];
      },
      (_seen, use) => [use("analyze_timeline")],
      () => [say("Removed the long silences and closed the gaps; the speech is untouched.")],
    ];
  };
}

/** Inserts the footage and cuts it at every second detected onset of the music (shifted by `shift` seconds). */
function cutToBeat(options: { shift: number }): () => Turn[] {
  return () => {
    let footageId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        footageId = assetNamed(seen, "footage.mp4").id;
        return [use("analyze_media", { assetId: assetNamed(seen, "track.mp3").id })];
      },
      (seen, use) => {
        const onsets = seen.data<AnalysisData>("analyze_media").strongestOnsets;
        const cuts = onsets.filter((_, i) => i % 2 === 1).map((t) => t + options.shift);
        return [say(`Laying the footage down and cutting at ${cuts.length} beats.`), use("insert_media", { assetId: footageId, start: 0 }), ...cuts.map((at) => use("split", { at })), use("get_timeline")];
      },
      (_seen, use) => [use("render_contact_sheet", { count: 6 }), use("analyze_timeline")],
      () => [say("Cut the footage to the beat of the track: a cut every other beat, music untouched.")],
    ];
  };
}

function numberFrom(brief: string, pattern: RegExp): number {
  const match = pattern.exec(brief);
  if (!match?.[1]) throw new Error(`policy: could not read a number with ${pattern} from the brief`);
  return Number(match[1]);
}

function trimToMiddle(options: { head: boolean; tail: boolean; tailTo?: number }): () => Turn[] {
  return () => {
    let clipId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        clipId = onlyElement(seen).id;
        const intro = numberFrom(seen.brief, /(\d+)-second intro/);
        return [say("Cutting the intro."), ...(options.head ? [use("trim", { elementId: clipId, start: intro })] : [])];
      },
      (seen, use) => {
        const target = numberFrom(seen.brief, /middle (\d+) seconds/);
        return options.tail ? [use("trim", { elementId: clipId, end: options.tailTo ?? target }), use("get_timeline")] : [use("get_timeline")];
      },
      () => [say("Trimmed the clip to its middle section.")],
    ];
  };
}

function captions(options: { offset?: number; dropLast?: boolean; twice?: boolean }): () => Turn[] {
  return () => [
    (_seen, use) => orient(use),
    (seen, use) => {
      const full = seen.brief.slice(seen.brief.indexOf("\n\n") + 2).trim();
      const srt = options.dropLast ? full.split(/\n\n/).slice(0, -1).join("\n\n") : full;
      const args = { srt, ...(options.offset === undefined ? {} : { offset: options.offset }) };
      return [say("Importing the subtitles."), use("import_captions", args), ...(options.twice ? [use("import_captions", args)] : []), use("render_frame", { time: 1 })];
    },
    () => [say("Added the captions at the times you gave.")],
  ];
}

function changeSpeed(options: { mode: "speed" | "trim" | "wrong" }): () => Turn[] {
  return () => {
    let clipId = "";
    let length = 0;
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        const clip = onlyElement(seen);
        clipId = clip.id;
        length = clip.duration;
        const target = numberFrom(seen.brief, /exactly (\d+) seconds/);
        if (options.mode === "trim") return [use("trim", { elementId: clipId, end: target })];
        return [use("set_speed", { elementId: clipId, speed: options.mode === "wrong" ? length / (target - 2) : length / target, maintainPitch: true })];
      },
      (_seen, use) => [use("get_timeline")],
      () => [say("Adjusted the clip so it fits.")],
    ];
  };
}

function addTitle(options: { fade: boolean; seconds?: number }): () => Turn[] {
  return () => {
    let seconds = 0;
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        const text = /"([^"]+)"/.exec(seen.brief)?.[1];
        if (!text) throw new Error("policy: no quoted title in the brief");
        seconds = options.seconds ?? numberFrom(seen.brief, /first (\d+) seconds/);
        return [use("insert_text", { text, start: 0, duration: seconds })];
      },
      (seen, use) => {
        const id = seen.data<{ elementId: string }>("insert_text").elementId;
        const keys: Array<[number, number]> = options.fade ? [[0, 0], [0.5, 1], [seconds - 0.5, 1], [seconds, 0]] : [];
        return [...keys.map(([time, value]) => use("add_keyframe", { elementId: id, property: "opacity", time, value })), use("get_element", { elementId: id })];
      },
      () => [say("Added the title with a fade in and a fade out.")],
    ];
  };
}

const COLOR_NAMES = /play (\w+) first, then (\w+), then (\w+)/;

function reorder(options: { swapOnly: boolean }): () => Turn[] {
  return () => [
    (_seen, use) => orient(use),
    (seen, use) => {
      const match = COLOR_NAMES.exec(seen.brief);
      if (!match) throw new Error("policy: could not read the wanted order");
      const wanted = [match[1], match[2], match[3]].map((c) => `${c}.mp4`);
      const elements = elementsOf(seen.data<TimelineData>("get_timeline")).sort((a, b) => a.start - b.start);
      const byName = (name: string): TimelineElement => {
        const found = elements.find((e) => e.name === name);
        if (!found) throw new Error(`policy: no clip named ${name}`);
        return found;
      };
      if (options.swapOnly) {
        const [first, second] = elements;
        if (!first || !second) throw new Error("policy: need two clips");
        return [use("move", { elementIds: [first.id], start: 100 }), use("move", { elementIds: [second.id], start: 0 }), use("move", { elementIds: [first.id], start: second.duration }), use("get_timeline")];
      }
      const park = use("move", { elementIds: elements.map((e) => e.id), delta: 100 });
      let cursor = 0;
      const placements = wanted.map((name) => {
        const clip = byName(name);
        const call = use("move", { elementIds: [clip.id], start: cursor });
        cursor += clip.duration;
        return call;
      });
      return [say("Parking the clips, then placing them in the new order."), park, ...placements, use("get_timeline")];
    },
    () => [say("Reordered the clips and kept them back to back.")],
  ];
}

function matchPacing(options: { mode: "pace" | "single" | "reference" }): () => Turn[] {
  return () => {
    let footageId = "";
    let referenceId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        footageId = assetNamed(seen, "footage.mp4").id;
        referenceId = assetNamed(seen, "reference.mp4").id;
        if (options.mode === "single") return [use("insert_media", { assetId: footageId })];
        if (options.mode === "reference") return [use("insert_media", { assetId: referenceId })];
        return [say("Measuring the reference first."), use("save_style_profile", { name: "reference pacing", assetIds: [referenceId] })];
      },
      (seen, use) => {
        if (options.mode !== "pace") return [use("get_timeline")];
        const { profileId } = seen.data<{ profileId: string }>("save_style_profile");
        return [use("plan_cuts_to_style", { profileId, assetIds: [footageId] })];
      },
      (seen, use) => {
        if (options.mode !== "pace") return [say("Done: the footage is on the timeline.")];
        return [use("apply_cut_plan", { plan: seen.data<{ plan: unknown }>("plan_cuts_to_style").plan })];
      },
      (_seen, use) => [use("analyze_timeline")],
      () => [say("Planned the cuts from the reference's shot-length profile and applied them to your footage.")],
    ];
  };
}

interface TranscriptMatches { matches: Array<{ startWord: number; endWord: number }> }
interface TranscriptView {
  sentences: Array<{ startWord: number; endWord: number }>;
  words?: Array<{ index: number; start: number; end: number }>;
}

/** The text between the first pair of double quotes in the brief: what the user says the speaker says. */
const quotedPhrase = (brief: string): string => /"([^"]+)"/.exec(brief)?.[1] ?? brief;

/** Finds the quoted sentence through the transcript tools, then removes it (or, for a mutation, something else). */
function deleteSpokenSentence(options: { mode: "exact" | "half" | "next-sentence" | "blunt" }): () => Turn[] {
  const BLUNT_MARGIN = 1.5;
  return () => {
    let cut = { start: 0, end: 0 };
    let elementId = "";
    const find: Turn = (seen, use) => {
      elementId = onlyElement(seen).id;
      return [say("Locating the sentence in the transcript."), use("search_transcript", { elementId, query: quotedPhrase(seen.brief) }), use("get_transcript", { elementId, includeWords: true })];
    };
    const remove: Turn = (seen, use) => {
      const [match] = seen.data<TranscriptMatches>("search_transcript").matches;
      if (!match) throw new Error("policy: the phrase was not found in the transcript");
      const deleteWords = (startWord: number, endWord: number): AssistantBlock[] => [use("delete_spoken_range", { elementId, startWord, endWord, ripple: true })];
      if (options.mode === "exact") return deleteWords(match.startWord, match.endWord);
      if (options.mode === "half") return deleteWords(match.startWord, match.startWord + Math.floor((match.endWord - match.startWord) / 2));
      const transcript = seen.data<TranscriptView>("get_transcript");
      if (options.mode === "next-sentence") {
        const next = transcript.sentences.find((s) => s.startWord > match.endWord);
        if (!next) throw new Error("policy: there is no sentence after the match");
        return deleteWords(next.startWord, next.endWord);
      }
      const first = transcript.words?.find((w) => w.index === match.startWord);
      const last = transcript.words?.find((w) => w.index === match.endWord);
      if (!first || !last) throw new Error("policy: word timings missing");
      cut = { start: Math.max(0, first.start - BLUNT_MARGIN), end: last.end + BLUNT_MARGIN };
      return [use("split", { at: cut.start }), use("split", { at: cut.end }), use("get_timeline")];
    };
    const bluntDelete: Turn = (seen, use) => {
      const middle = elementsOf(seen.data<TimelineData>("get_timeline")).filter((e) => e.start >= cut.start - SILENCE_EDGE_SLACK && e.end <= cut.end + SILENCE_EDGE_SLACK);
      return [use("delete", { elementIds: middle.map((e) => e.id), ripple: true })];
    };
    return [(_seen, use) => orient(use), find, remove, ...(options.mode === "blunt" ? [bluntDelete] : []), () => [say("Removed the sentence.")]];
  };
}

interface FoundMoments { moments: Array<{ assetId: string; startSeconds: number; endSeconds: number }> }
type MomentPick = { assetId: string; startSeconds: number; endSeconds: number };
const toPicks = (found: FoundMoments): MomentPick[] => found.moments.map(({ assetId, startSeconds, endSeconds }) => ({ assetId, startSeconds, endSeconds }));

/** Locates the sentences with the quoted word through find_moments, then assembles them with cut_to_moments. */
function findAndCut(options: { mode: "keyword" | "first-only" | "all-speech" | "reversed" | "highlight" | "appended-copy" }): () => Turn[] {
  return () => {
    let assetId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        assetId = assetNamed(seen, "interview.mp4").id;
        const query = options.mode === "all-speech" ? { speaking: true } : { text: quotedPhrase(seen.brief) };
        return [say("Finding the moments in the footage."), use("find_moments", { assetId, ...query, sort: "time" })];
      },
      (seen, use) => {
        const picks = toPicks(seen.data<FoundMoments>("find_moments"));
        const chosen = options.mode === "first-only" ? picks.slice(0, 1) : options.mode === "reversed" ? [...picks].reverse() : picks;
        return [say(`Assembling ${chosen.length} moment(s).`), use("cut_to_moments", { moments: chosen, ...(options.mode === "highlight" ? { replace: true } : {}) }), use("get_timeline")];
      },
      () => [say(options.mode === "appended-copy" ? "Done: the highlight is on the timeline." : "Built the sequence from the matching moments, back to back.")],
    ];
  };
}

/** Reads the shots and their loudness through find_moments, then lays them out starting with the chosen one. */
function loudestFirst(options: { lead: "loudest" | "quietest" | "none"; keepOthers: boolean }): () => Turn[] {
  return () => {
    let shots: MomentPick[] = [];
    let assetId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        assetId = assetNamed(seen, "scenes.mp4").id;
        return [use("find_moments", { assetId, sort: "time" })];
      },
      (seen, use) => {
        shots = toPicks(seen.data<FoundMoments>("find_moments"));
        return [use("find_moments", { assetId, sort: options.lead === "quietest" ? "quietest" : "loudest", limit: 1 })];
      },
      (seen, use) => {
        const [lead] = toPicks(seen.data<FoundMoments>("find_moments"));
        if (!lead) throw new Error("policy: no shot found");
        const others = shots.filter((s) => s.startSeconds !== lead.startSeconds);
        const order = options.lead === "none" ? shots : options.keepOthers ? [lead, ...others] : [lead];
        return [say("Putting the chosen shot first."), use("cut_to_moments", { moments: order }), use("get_timeline")];
      },
      () => [say("Arranged the shots with the loudest first.")],
    ];
  };
}

/** Searches the footage by what it shows through find_visual_moments, then assembles the moments with cut_to_moments. */
function findVisual(options: { mode: "subject" | "first-only" | "wrong-subject" }): () => Turn[] {
  return () => {
    let assetId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        assetId = assetNamed(seen, "pets.mp4").id;
        const query = options.mode === "wrong-subject" ? "whiteboard" : quotedPhrase(seen.brief);
        return [say("Searching the footage by what it shows."), use("find_visual_moments", { assetId, query, sort: "time" })];
      },
      (seen, use) => {
        const picks = toPicks(seen.data<FoundMoments>("find_visual_moments"));
        const chosen = options.mode === "first-only" ? picks.slice(0, 1) : picks;
        return [say(`Assembling ${chosen.length} moment(s).`), use("cut_to_moments", { moments: chosen }), use("get_timeline")];
      },
      () => [say("Built the sequence from the moments that show it, back to back.")],
    ];
  };
}

/** Makes the project vertical, then reframes the interview clip onto the speaker (or fakes it with a fixed crop). */
function reframeSpeaker(options: { mode: "faces" | "static-crop" | "wrong-canvas" }): () => Turn[] {
  return () => {
    let elementId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        const asset = assetNamed(seen, "interview.mp4");
        elementId = elementsOf(seen.data<TimelineData>("get_timeline")).find((e) => e.assetId === asset.id)?.id ?? "";
        return [
          say("Checking where the speaker is, then making the canvas vertical."),
          use("describe_faces", { assetId: asset.id }),
          ...(options.mode === "wrong-canvas" ? [] : [use("set_project", { canvasPreset: "9:16" })]),
        ];
      },
      (_seen, use) => {
        if (options.mode === "static-crop") {
          return [say("Cropping to the middle of the frame."), use("set_params", { elementId, params: { "transform.scaleX": 3.16, "transform.scaleY": 3.16 } })];
        }
        return [say("Reframing onto the speaker."), use("reframe_to_faces", { elementId })];
      },
      () => [say("The interview is vertical now and follows the speaker.")],
    ];
  };
}

/** Adds a transition between red.mp4 and blue.mp4 through add_transition, or a plausible wrong substitute. */
function addTransitionBetween(options: { mode: "dissolve" | "wrong-type" | "too-long" | "keyframes" }): () => Turn[] {
  return () => [
    (_seen, use) => orient(use),
    (seen, use) => {
      const timeline = seen.data<TimelineData>("get_timeline");
      const assets = seen.data<{ assets: AssetRow[] }>("list_assets").assets;
      const idOf = (name: string): string => {
        const asset = assets.find((a) => a.name === name);
        const element = elementsOf(timeline).find((e) => e.assetId === asset?.id);
        if (!element) throw new Error(`policy: no clip for ${name}`);
        return element.id;
      };
      const [from, to] = [idOf("red.mp4"), idOf("blue.mp4")];
      if (options.mode === "keyframes") {
        return [
          say("Fading the second clip in with opacity keyframes."),
          use("add_keyframe", { elementId: to, property: "opacity", time: 4, value: 0 }),
          use("add_keyframe", { elementId: to, property: "opacity", time: 5, value: 1 }),
        ];
      }
      const type = options.mode === "wrong-type" ? "wipe-left" : "dissolve";
      const duration = options.mode === "too-long" ? 3 : 1;
      return [say("Adding the transition between the two clips."), use("add_transition", { fromElementId: from, toElementId: to, type, duration }), use("get_timeline")];
    },
    () => [say("There is a cross dissolve between the two clips now.")],
  ];
}

/** Adds the title, then gives a clip the warm (or another) filter. */
function warmTitle(options: { filter: string; target: "title" | "video" }): () => Turn[] {
  return () => {
    let videoId = "";
    return [
      (_seen, use) => orient(use),
      (seen, use) => {
        const text = /"([^"]+)"/.exec(seen.brief)?.[1];
        if (!text) throw new Error("policy: no quoted title in the brief");
        videoId = elementsOf(seen.data<TimelineData>("get_timeline")).find((e) => e.type === "video")?.id ?? "";
        return [use("insert_text", { text, start: 0, duration: numberFrom(seen.brief, /for (\d+) seconds/) })];
      },
      (seen, use) => {
        const titleId = seen.data<{ elementId: string }>("insert_text").elementId;
        return [say("Applying the filter."), use("apply_filter", { elementIds: [options.target === "title" ? titleId : videoId], filter: options.filter })];
      },
      () => [say("The title has the warm look; the video is as it was.")],
    ];
  };
}

function ask(reply: string, extra: Turn[] = []): () => Turn[] {
  return () => [(_seen, use) => orient(use), ...extra, () => [say(reply)]];
}

const GUESSES: Turn[] = [
  (_seen, use) => [use("get_timeline"), use("insert_text", { text: "Better!", start: 0, duration: 3 })],
  () => [say("Done, I made it better.")],
];

const FAKES: Turn[] = [
  (_seen, use) => [use("insert_text", { text: "Voix francaise", start: 0, duration: 5 })],
  () => [say("Done, the voice is now French.")],
];

interface PolicySpec {
  id: string;
  caseId: string;
  kind: Policy["kind"];
  description: string;
  mustFail?: string[];
  turns: () => Turn[];
}

const SPECS: PolicySpec[] = [
  { id: "oracle", caseId: "remove-silences", kind: "oracle", description: "Analyse, split at long-silence edges, ripple-delete the silent pieces.", turns: removeSilences({ ripple: true, pad: 0 }) },
  { id: "no-ripple", caseId: "remove-silences", kind: "mutation", description: "Deletes the silent pieces but leaves the gaps open.", mustFail: ["no-long-silence"], turns: removeSilences({ ripple: false, pad: 0 }) },
  { id: "overreach-speech", caseId: "remove-silences", kind: "mutation", description: "Deletes each silence plus half a second of speech on both sides.", mustFail: ["speech-retained"], turns: removeSilences({ ripple: true, pad: 0.5 }) },

  { id: "oracle", caseId: "cut-to-beat", kind: "oracle", description: "Insert the footage and split it at every other detected onset.", turns: cutToBeat({ shift: 0 }) },
  { id: "off-beat", caseId: "cut-to-beat", kind: "mutation", description: "Cuts half a beat after the beats.", mustFail: ["cuts-on-beat"], turns: cutToBeat({ shift: 0.3 }) },

  { id: "oracle", caseId: "trim-to-duration", kind: "oracle", description: "Trim the head, then the tail, to the middle 8 seconds.", turns: trimToMiddle({ head: true, tail: true }) },
  { id: "head-only", caseId: "trim-to-duration", kind: "mutation", description: "Cuts the intro but forgets the outro.", mustFail: ["target-duration", "kept-the-middle"], turns: trimToMiddle({ head: true, tail: false }) },
  { id: "too-short", caseId: "trim-to-duration", kind: "mutation", description: "Cuts the tail too far, to 5 seconds.", mustFail: ["target-duration", "kept-the-middle"], turns: trimToMiddle({ head: true, tail: true, tailTo: 5 }) },

  { id: "oracle", caseId: "captions-from-srt", kind: "oracle", description: "Pass the SRT text to import_captions.", turns: captions({}) },
  { id: "shifted", caseId: "captions-from-srt", kind: "mutation", description: "Imports the cues one second late.", mustFail: ["captions-correct"], turns: captions({ offset: 1 }) },
  { id: "dropped-cue", caseId: "captions-from-srt", kind: "mutation", description: "Forgets the last cue.", mustFail: ["captions-correct", "no-extra-captions"], turns: captions({ dropLast: true }) },
  { id: "duplicated", caseId: "captions-from-srt", kind: "mutation", description: "Imports the captions twice.", mustFail: ["no-extra-captions"], turns: captions({ twice: true }) },

  { id: "oracle", caseId: "speed-to-fit", kind: "oracle", description: "set_speed to source length / target length.", turns: changeSpeed({ mode: "speed" }) },
  { id: "trim-instead", caseId: "speed-to-fit", kind: "mutation", description: "Cuts the clip to 8 seconds instead of speeding it up.", mustFail: ["whole-clip-kept"], turns: changeSpeed({ mode: "trim" }) },
  { id: "wrong-speed", caseId: "speed-to-fit", kind: "mutation", description: "Speeds up too much (6 s result).", mustFail: ["fits-duration"], turns: changeSpeed({ mode: "wrong" }) },

  { id: "oracle", caseId: "title-fade", kind: "oracle", description: "insert_text for 3 s with four opacity keyframes.", turns: addTitle({ fade: true }) },
  { id: "no-fade", caseId: "title-fade", kind: "mutation", description: "Adds the title but never animates it.", mustFail: ["opacity-fades"], turns: addTitle({ fade: false }) },
  { id: "wrong-length", caseId: "title-fade", kind: "mutation", description: "Title stays up for 5 seconds.", mustFail: ["title-text-and-timing"], turns: addTitle({ fade: true, seconds: 5 }) },

  { id: "oracle", caseId: "reorder-clips", kind: "oracle", description: "Park the clips far away, then place them in the wanted order.", turns: reorder({ swapOnly: false }) },
  { id: "swap-first-two", caseId: "reorder-clips", kind: "mutation", description: "Swaps the first two clips only.", mustFail: ["order"], turns: reorder({ swapOnly: true }) },

  { id: "oracle", caseId: "match-reference-pacing", kind: "oracle", description: "save_style_profile, plan_cuts_to_style, apply_cut_plan.", turns: matchPacing({ mode: "pace" }) },
  { id: "single-clip", caseId: "match-reference-pacing", kind: "mutation", description: "Puts the whole footage on the timeline as one shot.", mustFail: ["average-shot-length"], turns: matchPacing({ mode: "single" }) },
  { id: "uses-reference", caseId: "match-reference-pacing", kind: "mutation", description: "Edits with the reference itself.", mustFail: ["footage-only"], turns: matchPacing({ mode: "reference" }) },

  { id: "oracle", caseId: "delete-spoken-sentence", kind: "oracle", description: "search_transcript for the quoted words, delete_spoken_range on the match with ripple.", turns: deleteSpokenSentence({ mode: "exact" }) },
  { id: "half-sentence", caseId: "delete-spoken-sentence", kind: "mutation", description: "Deletes only the first half of the sentence's words.", mustFail: ["sentence-removed"], turns: deleteSpokenSentence({ mode: "half" }) },
  { id: "wrong-sentence", caseId: "delete-spoken-sentence", kind: "mutation", description: "Finds the phrase but deletes the sentence after it.", mustFail: ["sentence-removed", "other-speech-retained"], turns: deleteSpokenSentence({ mode: "next-sentence" }) },
  { id: "blunt-cut", caseId: "delete-spoken-sentence", kind: "mutation", description: "Cuts a second and a half around the sentence with split + delete, eating its neighbours.", mustFail: ["other-speech-retained"], turns: deleteSpokenSentence({ mode: "blunt" }) },

  { id: "oracle", caseId: "find-and-cut-phrase-moments", kind: "oracle", description: "find_moments for the quoted word, cut_to_moments on the results in time order.", turns: findAndCut({ mode: "keyword" }) },
  { id: "first-only", caseId: "find-and-cut-phrase-moments", kind: "mutation", description: "Assembles only the first matching sentence.", mustFail: ["keyword-sentences-kept"], turns: findAndCut({ mode: "first-only" }) },
  { id: "all-speech", caseId: "find-and-cut-phrase-moments", kind: "mutation", description: "Assembles every sentence, matching or not.", mustFail: ["nothing-else-kept"], turns: findAndCut({ mode: "all-speech" }) },
  { id: "reversed", caseId: "find-and-cut-phrase-moments", kind: "mutation", description: "Assembles the matching sentences in reverse order.", mustFail: ["spoken-order-back-to-back"], turns: findAndCut({ mode: "reversed" }) },

  { id: "oracle", caseId: "highlight-around-phrase", kind: "oracle", description: "find_moments for the quoted word, cut_to_moments with replace:true so the highlight becomes the timeline.", turns: findAndCut({ mode: "highlight" }) },
  { id: "appended-copy", caseId: "highlight-around-phrase", kind: "mutation", description: "The real failure: cut_to_moments without replace appends the highlight after the untouched original (a 41.5 s timeline), then claims it is done.", mustFail: ["timeline-is-the-highlight", "original-removed"], turns: findAndCut({ mode: "appended-copy" }) },

  { id: "oracle", caseId: "loudest-shot-first", kind: "oracle", description: "find_moments sorted by time and by loudness, cut_to_moments with the loudest shot first.", turns: loudestFirst({ lead: "loudest", keepOthers: true }) },
  { id: "original-order", caseId: "loudest-shot-first", kind: "mutation", description: "Cuts the shots but leaves them in their original order.", mustFail: ["loudest-leads"], turns: loudestFirst({ lead: "none", keepOthers: true }) },
  { id: "quietest-first", caseId: "loudest-shot-first", kind: "mutation", description: "Leads with the quietest shot instead.", mustFail: ["loudest-leads"], turns: loudestFirst({ lead: "quietest", keepOthers: true }) },
  { id: "loudest-only", caseId: "loudest-shot-first", kind: "mutation", description: "Keeps only the loudest shot.", mustFail: ["all-shots-kept"], turns: loudestFirst({ lead: "loudest", keepOthers: false }) },
  { id: "oracle", caseId: "find-visual-moment", kind: "oracle", description: "find_visual_moments for the quoted subject, cut_to_moments on the results in time order.", turns: findVisual({ mode: "subject" }) },
  { id: "first-only", caseId: "find-visual-moment", kind: "mutation", description: "Assembles only the first moment that shows the subject.", mustFail: ["subject-footage-kept"], turns: findVisual({ mode: "first-only" }) },
  { id: "wrong-subject", caseId: "find-visual-moment", kind: "mutation", description: "Searches for a different subject and assembles that.", mustFail: ["subject-footage-kept", "nothing-else-kept"], turns: findVisual({ mode: "wrong-subject" }) },
  { id: "oracle", caseId: "reframe-to-speaker", kind: "oracle", description: "describe_faces, set_project 9:16, reframe_to_faces on the interview clip.", turns: reframeSpeaker({ mode: "faces" }) },
  { id: "static-crop", caseId: "reframe-to-speaker", kind: "mutation", description: "Makes the canvas vertical and crops to the middle of the frame, never following the speaker.", mustFail: ["speaker-in-frame"], turns: reframeSpeaker({ mode: "static-crop" }) },
  { id: "wrong-canvas", caseId: "reframe-to-speaker", kind: "mutation", description: "Reframes onto the speaker but leaves the canvas 16:9.", mustFail: ["canvas-is-vertical"], turns: reframeSpeaker({ mode: "wrong-canvas" }) },

  { id: "oracle", caseId: "add-transition-between-clips", kind: "oracle", description: "add_transition from red.mp4 to blue.mp4, dissolve, 1 s.", turns: addTransitionBetween({ mode: "dissolve" }) },
  { id: "wrong-type", caseId: "add-transition-between-clips", kind: "mutation", description: "Adds a wipe instead of a cross dissolve.", mustFail: ["dissolve-between"], turns: addTransitionBetween({ mode: "wrong-type" }) },
  { id: "too-long", caseId: "add-transition-between-clips", kind: "mutation", description: "Asks for a 3 s dissolve (the engine clamps it to half the shorter clip).", mustFail: ["dissolve-between"], turns: addTransitionBetween({ mode: "too-long" }) },
  { id: "fake-with-keyframes", caseId: "add-transition-between-clips", kind: "mutation", description: "Fakes the blend with opacity keyframes on the second clip instead of a transition.", mustFail: ["dissolve-between"], turns: addTransitionBetween({ mode: "keyframes" }) },

  { id: "oracle", caseId: "apply-warm-filter-to-title-clip", kind: "oracle", description: "insert_text for 3 s, apply_filter warm to the title only.", turns: warmTitle({ filter: "warm", target: "title" }) },
  { id: "filter-on-video", caseId: "apply-warm-filter-to-title-clip", kind: "mutation", description: "Warms the video clip instead of the title.", mustFail: ["title-is-warm", "video-untouched"], turns: warmTitle({ filter: "warm", target: "video" }) },
  { id: "cool-filter", caseId: "apply-warm-filter-to-title-clip", kind: "mutation", description: "Gives the title the cool filter.", mustFail: ["title-is-warm"], turns: warmTitle({ filter: "cool", target: "title" }) },
  {
    id: "oracle", caseId: "ambiguous-request", kind: "oracle", description: "Inspect, then ask what 'better' means.",
    turns: ask("What would you like me to improve: the pacing, the audio level, add titles or captions, or something else? Tell me what 'better' means for this video and I'll do it."),
  },
  { id: "guesses", caseId: "ambiguous-request", kind: "mutation", description: "Guesses and adds a title.", mustFail: ["project-unchanged"], turns: () => GUESSES },
  {
    id: "oracle", caseId: "impossible-request", kind: "oracle", description: "Inspect, then say the tools cannot do it.",
    turns: ask("I can't do that: I have no tool for speech synthesis or translation, so I can't replace the voice. I can edit, caption or re-time the existing audio instead."),
  },
  { id: "fakes", caseId: "impossible-request", kind: "mutation", description: "Pretends by adding a text clip.", mustFail: ["project-unchanged", "asks-or-declines"], turns: () => FAKES },
];

/** Generic mutations every runnable case must catch. `mustFail` is the task check that each one breaks. */
const LAZY_FAILS: Record<string, string[]> = {
  "remove-silences": ["no-long-silence"],
  "cut-to-beat": ["cuts-on-beat"],
  "trim-to-duration": ["target-duration", "kept-the-middle"],
  "captions-from-srt": ["captions-correct"],
  "speed-to-fit": ["fits-duration"],
  "title-fade": ["title-text-and-timing", "opacity-fades"],
  "reorder-clips": ["order"],
  "match-reference-pacing": ["average-shot-length"],
  "ambiguous-request": ["asks-or-declines"],
  "impossible-request": ["asks-or-declines"],
  "delete-spoken-sentence": ["sentence-removed"],
  "find-and-cut-phrase-moments": ["keyword-sentences-kept"],
  "highlight-around-phrase": ["timeline-is-the-highlight", "original-removed"],
  "loudest-shot-first": ["loudest-leads", "all-shots-kept"],
  "find-visual-moment": ["subject-footage-kept"],
  "reframe-to-speaker": ["canvas-is-vertical", "speaker-in-frame"],
  "add-transition-between-clips": ["dissolve-between"],
  "apply-warm-filter-to-title-clip": ["title-present", "title-is-warm"],
};

const OVERREACH_FAILS: Record<string, string[]> = {
  "remove-silences": ["speech-retained"],
  "cut-to-beat": ["cuts-on-beat"],
  "trim-to-duration": ["target-duration", "kept-the-middle"],
  "captions-from-srt": ["captions-correct"],
  "speed-to-fit": ["fits-duration", "whole-clip-kept"],
  "title-fade": ["title-text-and-timing", "opacity-fades"],
  "reorder-clips": ["order", "back-to-back-and-intact"],
  "match-reference-pacing": ["average-shot-length"],
  "ambiguous-request": ["project-unchanged"],
  "impossible-request": ["project-unchanged"],
  "delete-spoken-sentence": ["other-speech-retained"],
  "find-and-cut-phrase-moments": ["keyword-sentences-kept"],
  "highlight-around-phrase": ["highlight-sentences-kept"],
  "loudest-shot-first": ["loudest-leads", "all-shots-kept"],
  "find-visual-moment": ["subject-footage-kept"],
  "reframe-to-speaker": ["canvas-is-vertical", "speaker-in-frame", "whole-clip-kept"],
  "add-transition-between-clips": ["dissolve-between", "clips-untouched"],
  "apply-warm-filter-to-title-clip": ["title-present", "title-is-warm", "video-untouched"],
};

function generic(): PolicySpec[] {
  return Object.keys(LAZY_FAILS).flatMap((caseId): PolicySpec[] => [
    { id: "lazy", caseId, kind: "mutation", description: "Claims success without calling any tool.", mustFail: LAZY_FAILS[caseId] ?? [], turns: () => SAYS_DONE },
    { id: "overreach", caseId, kind: "mutation", description: "Deletes every clip on the timeline.", mustFail: OVERREACH_FAILS[caseId] ?? [], turns: () => DELETE_EVERYTHING },
  ]);
}

export const POLICIES: ReadonlyArray<Policy> = [...SPECS, ...generic()].map((spec) => ({
  id: spec.id, caseId: spec.caseId, kind: spec.kind, description: spec.description, mustFail: spec.mustFail ?? [],
  build: () => scripted(spec.turns()),
}));

export const policiesFor = (caseId: string): Policy[] => POLICIES.filter((p) => p.caseId === caseId);

export function oracleFor(caseId: string): Policy {
  const found = POLICIES.find((p) => p.caseId === caseId && p.kind === "oracle");
  if (!found) throw new Error(`No oracle policy for case "${caseId}"`);
  return found;
}
