export interface Translator {
  /** Translates each text on its own, keeping order. Never merges or splits entries. */
  translate(input: { texts: ReadonlyArray<string>; source: string; target: string; signal?: AbortSignal }): Promise<string[]>;
}
