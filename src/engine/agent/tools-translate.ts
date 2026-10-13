import type { TextElement } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { LANGUAGE_NAMES, TRANSLATION_PAIRS, captionText, findPair, isCaptionClip, translateCaptionClips, type Translator } from "#/engine/translate";
import { defineTool, ok, toSec, ToolError } from "./env";
import type { AgentTool } from "./types";

/** Injected by the app: the on-device translator, consent-gated like the speech models. */
export interface TranslateDeps {
  translator: Translator;
}

const MAX_CAPTIONS = 400;
const PAIR_LIST = TRANSLATION_PAIRS.map((p) => `${p.source}->${p.target}`).join(", ");

export function createTranslateTools(deps: TranslateDeps): AgentTool[] {
  const translate = defineTool<{ targetLanguage: string; sourceLanguage?: string; elementIds?: string[]; trackId?: string }>({
    name: "translate_captions",
    description:
      `Translates caption text clips into another language with an on-device model (Helsinki-NLP opus-mt) and adds the result as NEW caption track(s) at the top, with the same timing, style and animation; the originals are kept. Supported pairs: ${PAIR_LIST}. Which clips: elementIds (text clips), or trackId (every text clip on that track), or by default every clip named "Caption N" (made by caption import or add_captions_from_transcript). Captions are translated one at a time without surrounding context, so short fragments can come out literal or wrong: tell the user to read them before publishing. The model downloads once with the user's consent (the call fails with a hint until they approved it in the Captions panel). One undo step. Returns the new element ids and the source/translated text.`,
    inputSchema: {
      type: "object",
      properties: {
        targetLanguage: { type: "string", description: `Language code. Supported: ${Object.keys(LANGUAGE_NAMES).join(", ")} (only the listed pairs work).` },
        sourceLanguage: { type: "string", description: "Language code of the captions (default en)." },
        elementIds: { type: "array", items: { type: "string" } },
        trackId: { type: "string", description: "A text track id from get_timeline." },
      },
      required: ["targetLanguage"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const source = input.sourceLanguage ?? "en";
      const pair = findPair(source, input.targetLanguage);
      if (!pair) throw new ToolError(`Translating ${source} to ${input.targetLanguage} is not supported.`, `Supported pairs: ${PAIR_LIST}.`);
      if (input.elementIds && input.trackId) throw new ToolError("Pass either elementIds or trackId, not both.");
      let sources: TextElement[];
      if (input.elementIds) {
        sources = env.requireMany(input.elementIds).map((l) => {
          if (l.element.type !== "text") throw new ToolError(`"${l.element.id}" is a ${l.element.type} clip, not text.`, "Pick text/caption clips from get_timeline.");
          return l.element;
        });
      } else if (input.trackId) {
        const track = env.requireTrack(input.trackId);
        if (track.type !== "text") throw new ToolError(`Track "${track.id}" is a ${track.type} track, not a text track.`);
        sources = (track.elements as TextElement[]).slice();
      } else {
        sources = allElements(env.tracks).map((l) => l.element).filter(isCaptionClip);
      }
      sources = sources.filter((e) => captionText(e) !== "").sort((a, b) => a.startTime - b.startTime);
      if (sources.length === 0) throw new ToolError("There are no captions to translate.", 'Create captions first (add_captions_from_transcript or import an .srt), or pass elementIds of text clips.');
      if (sources.length > MAX_CAPTIONS) throw new ToolError(`Too many captions (${sources.length}); at most ${MAX_CAPTIONS} per call.`, "Pass elementIds for a part of them.");

      let result;
      try {
        result = await translateCaptionClips({ editor: env.editor, sources, source, target: input.targetLanguage, translator: deps.translator });
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : String(error), "Nothing was changed.");
      }
      const label = LANGUAGE_NAMES[input.targetLanguage] ?? input.targetLanguage;
      const ids = result.elementIds;
      const trackIds = [...new Set(ids.map((id) => env.require(id).track.id))];
      return ok(`Translated ${sources.length} caption(s) to ${label} onto ${trackIds.length} new track(s). Machine translation: review before publishing.`, {
        count: sources.length, trackIds, elementIds: ids, model: pair.model,
        captions: result.pairs.map((p) => {
          const src = sources.find((e) => e.id === p.sourceId) as TextElement;
          return { elementId: p.elementId, from: p.from, to: p.to, start: toSec(src.startTime), end: toSec(src.startTime + src.duration) };
        }),
      });
    },
  });
  return [translate];
}
