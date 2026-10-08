import type { ReactNode } from "react";
import { MODEL_DOWNLOAD_NOTE } from "#/app/transcribe-service";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";

export function TranscribeDialog({ assetName, onConfirm, onClose }: { assetName: string | null; onConfirm: () => void; onClose: () => void }): ReactNode {
  return (
    <Dialog
      open={assetName !== null}
      onClose={onClose}
      title="Download the speech model?"
      description={`Transcribing "${assetName ?? ""}" needs a one-time download of the ${MODEL_DOWNLOAD_NOTE.model} speech model (about ${MODEL_DOWNLOAD_NOTE.approxMegabytes} MB, up to ${MODEL_DOWNLOAD_NOTE.approxMegabytesGpu} MB with GPU acceleration) from Hugging Face.`}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button data-autofocus onClick={onConfirm}>Download and transcribe</Button>
        </>
      )}
    >
      <p>The model is saved in this browser and reused afterwards. Your audio stays on this device: speech recognition runs locally and nothing is uploaded.</p>
    </Dialog>
  );
}
