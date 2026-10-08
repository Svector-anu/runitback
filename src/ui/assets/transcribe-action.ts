import { getTranscribeService, type TranscribeOutcome } from "#/app/transcribe-service";
import { toast } from "../primitives/toast";

/** Runs a transcription for the UI and reports the outcome as a toast. Returns "needs-consent" so the caller can ask first. */
export async function transcribeWithToast(input: { assetId: string; assetName: string }): Promise<TranscribeOutcome["status"]> {
  const outcome = await getTranscribeService().begin(input.assetId);
  if (outcome.status === "done") toast.success(`Transcribed ${input.assetName}`, `${outcome.transcript.words.length} words found.`);
  else if (outcome.status === "error") toast.error(`Could not transcribe ${input.assetName}`, outcome.message);
  return outcome.status;
}
