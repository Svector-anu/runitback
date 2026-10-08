import type { Transcript, TranscriptStore } from "#/engine/transcript/types";
import { KeyValueStore, openDatabase } from "#/platform/idb";

export const TRANSCRIPT_DB_NAME = "runitback-transcripts";
export const TRANSCRIPT_DB_VERSION = 1;
const TRANSCRIPT_STORE = "transcripts";

/** Transcripts persist in their own database so the project database version never changes. */
export class IdbTranscriptStore implements TranscriptStore {
  private readonly store: KeyValueStore<Transcript>;

  constructor(factory?: IDBFactory) {
    const db = openDatabase({ name: TRANSCRIPT_DB_NAME, version: TRANSCRIPT_DB_VERSION, stores: [{ name: TRANSCRIPT_STORE }], factory });
    this.store = new KeyValueStore<Transcript>(db, TRANSCRIPT_STORE);
  }

  get(assetId: string): Promise<Transcript | undefined> {
    return this.store.get(assetId);
  }

  save(transcript: Transcript): Promise<void> {
    return this.store.put(transcript, transcript.assetId);
  }

  delete(assetId: string): Promise<void> {
    return this.store.delete(assetId);
  }
}
