import { batch, insertElementsOnLanes } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import type { TextElement } from "#/engine/model";
import { captionText, translatedCaption } from "./captions";
import { LANGUAGE_NAMES, findPair } from "./pairs";
import type { Translator } from "./types";

export interface CaptionTranslation {
  elementIds: string[];
  pairs: Array<{ elementId: string; sourceId: string; from: string; to: string }>;
}

/**
 * Translates `sources` and inserts the result as new caption track(s) at the top in one undo step; the originals stay.
 * The translator runs before anything is edited, so a failure leaves the project untouched.
 */
export async function translateCaptionClips(input: {
  editor: Editor; sources: ReadonlyArray<TextElement>; source: string; target: string; translator: Translator; signal?: AbortSignal;
}): Promise<CaptionTranslation> {
  const { editor } = input;
  if (!findPair(input.source, input.target)) throw new Error(`Translating ${input.source} to ${input.target} is not supported`);
  const sources = input.sources.filter((e) => captionText(e) !== "").slice().sort((a, b) => a.startTime - b.startTime);
  if (sources.length === 0) throw new Error("There are no captions to translate");
  const texts = await input.translator.translate({
    texts: sources.map(captionText), source: input.source, target: input.target, ...(input.signal ? { signal: input.signal } : {}),
  });
  if (texts.length !== sources.length) throw new Error("The translator returned a different number of captions than it was given");
  const canvas = editor.getState().doc.settings.canvasSize;
  const label = LANGUAGE_NAMES[input.target] ?? input.target;
  const ids = sources.map(() => editor.newId());
  const elements = sources.map((source, i) => translatedCaption({ source, translated: texts[i] as string, id: ids[i] as string, name: `Caption ${i + 1} (${label})`, canvas }));
  editor.execute(batch("Translate captions", [insertElementsOnLanes({ elements, index: 0, label: "Translate captions" })]));
  return {
    elementIds: ids,
    pairs: sources.map((src, i) => ({ elementId: ids[i] as string, sourceId: src.id, from: captionText(src), to: texts[i] as string })),
  };
}
