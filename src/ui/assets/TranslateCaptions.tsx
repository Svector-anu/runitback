import { useState, type ReactNode } from "react";
import { TRANSLATION_PAIRS, pairOf } from "#/engine/translate";
import { getTranslateService } from "#/app/translate-service";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { SelectField } from "../primitives/fields";
import { toast } from "../primitives/toast";

/** Translate the captions (or the selected caption clips) into a new caption track with an on-device model. */
export function TranslateCaptions(): ReactNode {
  const service = getTranslateService();
  const running = service.state.use((s) => s.running);
  const [pairId, setPairId] = useState(TRANSLATION_PAIRS[0]?.id ?? "");
  const [asking, setAsking] = useState(false);
  const pair = pairOf(pairId);

  const run = async (): Promise<void> => {
    const outcome = await service.begin({ pairId });
    if (outcome.status === "needs-consent") setAsking(true);
    else if (outcome.status === "done") toast.success(`Translated ${outcome.count} caption${outcome.count === 1 ? "" : "s"}`, "Added as a new caption track. Read it before publishing: it is machine translation.");
    else if (outcome.status === "error") toast.error("Could not translate the captions", outcome.message);
  };
  const confirm = (): void => {
    service.grantConsent(pairId);
    setAsking(false);
    void run();
  };

  return (
    <section className="translate" aria-label="Translate captions" data-testid="translate-captions">
      <div className="tts__title">Translate captions</div>
      <SelectField label="Language" value={pairId} options={TRANSLATION_PAIRS.map((p) => ({ value: p.id, label: p.label }))} onChange={setPairId} disabled={running} />
      <div className="tts__actions">
        {running ? (
          <>
            <span className="muted" role="status">Translating... the first run downloads the model.</span>
            <Button variant="outline" size="sm" onClick={() => service.cancel()}>Cancel</Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void run()}>Translate</Button>
        )}
      </div>
      <p className="muted tts__note">
        Translates the selected captions, or all of them, into a new track and keeps the originals. Machine translation by Helsinki-NLP opus-mt, one caption at a time without context: it is usually fine for plain sentences and weak on slang, names and fragments. Always read the result before publishing.
      </p>
      <Dialog
        open={asking}
        onClose={() => setAsking(false)}
        title="Download the translation model?"
        description={`${pair?.label ?? "This language"} needs a one-time download of a translation model (about ${pair?.approxMegabytes ?? 120} MB) from Hugging Face.`}
        footer={(
          <>
            <Button variant="outline" onClick={() => setAsking(false)}>Cancel</Button>
            <Button data-autofocus onClick={confirm}>Download and translate</Button>
          </>
        )}
      >
        <p>The model ({pair?.model}, {pair?.license}) is saved in this browser and reused afterwards. Your captions stay on this device: translation runs locally and nothing is uploaded.</p>
      </Dialog>
    </section>
  );
}
