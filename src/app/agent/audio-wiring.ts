import { createNoiseTools, createTranslateTools, createVoiceoverTools, type AgentTool } from "#/engine/agent";
import { getTranslateService } from "../translate-service";
import { getServices } from "../services";
import { getVoiceService } from "../voice-service";

/** Noise removal backed by the page's shared denoise cache: the same processed audio that playback and export use. */
function createAppNoiseTools(): AgentTool[] {
  return createNoiseTools({
    async prepare({ assetId }) {
      const audio = await getServices().runtime.audio.prepareDenoise(assetId);
      return { noiseFloorBeforeDb: audio.noiseFloorDb.before, noiseFloorAfterDb: audio.noiseFloorDb.after };
    },
  });
}

/** Noise removal, text-to-speech and caption translation: on-device models behind the consent gates of their services. */
export function createAppAudioTools(): AgentTool[] {
  const voice = getVoiceService();
  return [
    ...createAppNoiseTools(),
    ...createVoiceoverTools({ engine: voice.gatedEngine, importAudio: (input) => voice.importWav(input) }),
    ...createTranslateTools({ translator: getTranslateService().gatedTranslator }),
  ];
}
