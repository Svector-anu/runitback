import { createVoiceoverTools, type AgentTool } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { mediaTimeFromSeconds } from "#/engine/time";
import type { SpeechEngine } from "#/engine/voiceover";

const SAMPLE_RATE = 16_000;
const SECONDS_PER_CHARACTER = 0.06;

/** Deterministic stand-in for the speech model: a quiet tone whose length depends only on the text, so ground truth is exact. */
export const stubSpeechEngine: SpeechEngine = {
  async synthesize({ text }) {
    const length = Math.max(1, Math.round(text.length * SECONDS_PER_CHARACTER * SAMPLE_RATE));
    return { sampleRate: SAMPLE_RATE, samples: Float32Array.from({ length }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 200 * i) / SAMPLE_RATE)) };
  },
};

/** The voice-over tools over the stub engine; the "stored" file is only registered as an asset, as nothing decodes it headlessly. */
export function voiceoverToolsFor(editor: Editor): AgentTool[] {
  let count = 0;
  return createVoiceoverTools({
    engine: stubSpeechEngine,
    async importAudio({ name, wav }) {
      const seconds = (wav.length - 44) / 2 / SAMPLE_RATE;
      const asset: MediaAssetInfo = { id: `voice-over-${++count}`, name, type: "audio", size: wav.length, lastModified: 0, duration: mediaTimeFromSeconds(seconds) };
      editor.registerAsset(asset);
      return asset;
    },
  });
}
