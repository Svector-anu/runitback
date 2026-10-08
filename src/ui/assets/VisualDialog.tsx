import type { ReactNode } from "react";
import { VISUAL_MODEL_NOTE } from "#/app/visual-service";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";

export function VisualDialog({ assetName, onConfirm, onClose }: { assetName: string | null; onConfirm: () => void; onClose: () => void }): ReactNode {
  return (
    <Dialog
      open={assetName !== null}
      onClose={onClose}
      title="Download the visual search model?"
      description={`Indexing "${assetName ?? ""}" needs a one-time download of the ${VISUAL_MODEL_NOTE.model} image model (about ${VISUAL_MODEL_NOTE.approxMegabytes} MB) from Hugging Face.`}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button data-autofocus onClick={onConfirm}>Download and index</Button>
        </>
      )}
    >
      <p>The model is saved in this browser and reused afterwards. Your video stays on this device: frames are analysed locally and nothing is uploaded.</p>
    </Dialog>
  );
}
