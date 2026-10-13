import { useState, type ReactNode } from "react";
import { DEFAULT_VOICE_ID, MAX_VOICEOVER_CHARS, SPEED_MAX, SPEED_MIN, VOICES } from "#/engine/voiceover";
import { TTS_DOWNLOAD_NOTE, getVoiceService } from "#/app/voice-service";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Field, SelectField } from "../primitives/fields";
import { toast } from "../primitives/toast";

const SAMPLE = "Welcome to the show. Today we are going to talk about editing video.";

/** Text to speech for voice-overs: on-device, consent-gated, inserted at the playhead as an audio clip. */
export function TextToSpeechPanel(): ReactNode {
  const service = getVoiceService();
  const state = service.state.use((s) => s);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(DEFAULT_VOICE_ID);
  const [speed, setSpeed] = useState(1);
  const [asking, setAsking] = useState(false);

  const run = async (): Promise<void> => {
    const outcome = await service.begin({ text, voiceId: voice, speed });
    if (outcome.status === "needs-consent") setAsking(true);
    else if (outcome.status === "done") toast.success("Voice-over added", `${outcome.seconds.toFixed(1)} seconds at the playhead on an audio track.`);
    else if (outcome.status === "error") toast.error("Could not generate the voice-over", outcome.message);
  };
  const confirm = (): void => {
    service.grantConsent();
    setAsking(false);
    void run();
  };

  return (
    <section className="tts" aria-label="Text to speech" data-testid="tts-panel">
      <div className="tts__title">Text to speech</div>
      <Field label="Script">
        <textarea className="textarea" aria-label="Voice-over script" rows={4} maxLength={MAX_VOICEOVER_CHARS} value={text} placeholder={SAMPLE}
          disabled={state.running} onChange={(e) => setText(e.target.value)} />
      </Field>
      <SelectField label="Voice" value={voice} options={VOICES.map((v) => ({ value: v.id, label: v.label }))} onChange={setVoice} disabled={state.running} />
      <Field label={`Speed ${speed.toFixed(2)}x`}>
        <input type="range" className="slider" aria-label="Speech speed" min={SPEED_MIN} max={SPEED_MAX} step={0.05} value={speed}
          disabled={state.running} onChange={(e) => setSpeed(Number(e.target.value))} />
      </Field>
      <div className="tts__actions">
        {state.running ? (
          <>
            <span className="muted" role="status" data-testid="tts-status" data-phase={state.phase}>
              {state.phase === "downloading" ? `Downloading the voice model... ${Math.round(state.progress * 100)}%` : `Generating speech... ${Math.round(state.progress * 100)}%`}
            </span>
            <Button variant="outline" size="sm" onClick={() => service.cancel()}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" disabled={text.trim() === ""} onClick={() => void run()}>Generate voice-over</Button>
        )}
      </div>
      <p className="muted tts__note">English only, clearly synthetic: expect an audible robotic quality and occasional mispronunciations of names and numbers. It runs on this device; nothing is uploaded.</p>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Download the voice model?"
        description={`Generating a voice-over needs a one-time download of the ${TTS_DOWNLOAD_NOTE.model} (about ${TTS_DOWNLOAD_NOTE.approxMegabytes} MB) from Hugging Face.`}
        footer={(
          <>
            <Button variant="outline" onClick={() => setAsking(false)}>Cancel</Button>
            <Button data-autofocus onClick={confirm}>Download and generate</Button>
          </>
        )}
      >
        <p>The model is saved in this browser and reused afterwards. Your text stays on this device: speech is generated locally and nothing is uploaded.</p>
      </Dialog>
    </section>
  );
}
