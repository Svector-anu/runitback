import type { ReactNode } from "react";
import type { ModelDownload } from "#/engine/understand";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";

export function UnderstandDialog({ downloads, label, onConfirm, onClose }: { downloads: ModelDownload[] | null; label: string; onConfirm: () => void; onClose: () => void }): ReactNode {
  const total = (downloads ?? []).reduce((sum, d) => sum + d.approxMegabytes, 0);
  return (
    <Dialog
      open={downloads !== null}
      onClose={onClose}
      title="Download the models to understand your footage?"
      description={`Understanding ${label} needs one-time downloads of ${downloads?.length ?? 0} model${downloads?.length === 1 ? "" : "s"} (about ${total} MB in total) from Hugging Face.`}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button data-autofocus onClick={onConfirm}>Download and understand</Button>
        </>
      )}
    >
      <ul>
        {(downloads ?? []).map((d) => <li key={d.stage}>{d.model} (about {d.approxMegabytes} MB)</li>)}
      </ul>
      <p>The models are saved in this browser and reused afterwards. Your media stays on this device: silence, speech, frames and faces are analysed locally and nothing is uploaded.</p>
    </Dialog>
  );
}
