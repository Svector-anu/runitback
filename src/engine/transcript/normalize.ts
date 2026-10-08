/** Lowercased letters and digits only, so "Don't," and "dont" compare equal. Empty for pure punctuation. */
export function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Query text as normalized tokens; tokens that are only punctuation are dropped. */
export function tokenizeQuery(query: string): string[] {
  return query.split(/\s+/).map(normalizeToken).filter((token) => token !== "");
}
