import type { ReactNode } from "react";
import { Icon } from "../icons";
import { useHint } from "../lib/hints";
import { Button } from "../primitives/Button";

/** One-time explanation shown above the first imported footage. */
export function UnderstandIntro(): ReactNode {
  const { visible, dismiss } = useHint("understand-intro");
  if (!visible) return null;
  return (
    <aside className="hint-card" data-testid="understand-hint" aria-label="About Understand">
      <div className="hint-card__head">
        <strong>Understand lets the agent see your footage</strong>
        <Button variant="text" size="icon" label="Dismiss this tip" onClick={dismiss}><Icon name="x" size={14} /></Button>
      </div>
      <p>It finds silences, speech, scenes and faces in each clip. Everything runs on this device and nothing is uploaded.</p>
      <p>The first run asks before downloading two small models from Hugging Face: Whisper (about 50 MB) and CLIP (about 156 MB).</p>
      <p className="hint-card__legend"><b>Queued</b> waits its turn. <b>Partial</b> means a step failed or is missing. <b>Understood</b> means all done.</p>
    </aside>
  );
}
