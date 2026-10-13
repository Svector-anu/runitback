import { encodeWav } from "#/engine/audio";
import { buildMediaElement, type MediaAssetInfo } from "#/engine/model";
import { mediaTime } from "#/engine/time";
import {
  DEFAULT_VOICE_ID, MAX_VOICEOVER_CHARS, SPEED_MAX, SPEED_MIN, VOICES, findVoice, synthesizeVoiceover, type SpeechEngine,
} from "#/engine/voiceover";
import { defineTool, ok, ToolError } from "./env";
import { PLACEMENT_PROPS, place } from "./tools-insert";
import type { AgentTool } from "./types";

/** Injected by the app: the on-device speech engine (consent-gated) and the asset store. */
export interface VoiceoverDeps {
  engine: SpeechEngine;
  /** Stores the WAV as a project asset (probed, persisted, registered with the editor) and returns it. */
  importAudio(input: { name: string; wav: Uint8Array }): Promise<MediaAssetInfo>;
}

const NAME_CHARS = 32;

export function createVoiceoverTools(deps: VoiceoverDeps): AgentTool[] {
  const listVoices = defineTool<Record<string, never>>({
    name: "list_voices",
    description: "Lists the text-to-speech voices generate_voiceover can use. All voices speak English (SpeechT5 voice model); they differ in timbre and accent.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: () => ok(`${VOICES.length} voices.`, { default: DEFAULT_VOICE_ID, voices: VOICES.map((v) => ({ id: v.id, label: v.label, description: v.description })) }),
  });

  const generate = defineTool<{ text: string; voice?: string; speed?: number; start?: number; trackId?: string; newTrack?: boolean }>({
    name: "generate_voiceover",
    description:
      `Turns text into spoken English with an on-device model and places it on an audio track as a new audio clip (voice-over). Voices: ${VOICES.map((v) => v.id).join(", ")} (default ${DEFAULT_VOICE_ID}; see list_voices). speed ${SPEED_MIN}-${SPEED_MAX} (1 = natural, pitch is preserved). Up to ${MAX_VOICEOVER_CHARS} characters; numbers are spelled out. Without start the clip is appended to the first audio track; start is in SECONDS. The model downloads once with the user's consent (the call fails with a hint until they have approved it in the Assets > Text panel). Quality is clearly synthetic, not studio narration; the generated file is also kept as a project asset. One undo step.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to say." },
        voice: { type: "string", description: `Voice id (default ${DEFAULT_VOICE_ID}).` },
        speed: { type: "number", minimum: SPEED_MIN, maximum: SPEED_MAX },
        ...PLACEMENT_PROPS,
      },
      required: ["text"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const voiceId = input.voice ?? DEFAULT_VOICE_ID;
      if (!findVoice(voiceId)) throw new ToolError(`No voice "${voiceId}".`, `Use one of: ${VOICES.map((v) => v.id).join(", ")}.`);
      let speech;
      try {
        speech = await synthesizeVoiceover({ engine: deps.engine, text: input.text, voiceId, speed: input.speed ?? 1 });
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : String(error), "Nothing was changed.");
      }
      const label = input.text.replace(/\s+/g, " ").trim();
      const name = `Voice-over: ${label.length > NAME_CHARS ? `${label.slice(0, NAME_CHARS)}...` : label}.wav`;
      const asset = await deps.importAudio({ name, wav: encodeWav({ channels: [speech.samples], sampleRate: speech.sampleRate }) });
      const element = buildMediaElement({ id: env.editor.newId(), startTime: mediaTime(0), asset });
      const placed = place(env, { element, start: input.start === undefined ? undefined : env.snap(input.start), trackId: input.trackId, newTrack: input.newTrack }, "voice-over");
      if (!placed.ok) return placed;
      return ok(placed.summary, { ...(placed.data as Record<string, unknown>), assetId: asset.id, voice: voiceId, speed: input.speed ?? 1, seconds: Math.round((speech.samples.length / speech.sampleRate) * 100) / 100 });
    },
  });
  return [listVoices, generate];
}
