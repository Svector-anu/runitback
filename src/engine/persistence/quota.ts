export const STORAGE_HEADROOM_BYTES = 50 * 1024 * 1024;

export type QuotaDecision = { canStore: true; reason: "enough-space" | "estimate-unavailable" } | { canStore: false; reason: "insufficient-space" };

/** Unknown estimates allow the write; known ones must leave 50 MiB of headroom. */
export function canStoreFile(input: { size: number; usage?: number; quota?: number }): QuotaDecision {
  if (input.usage === undefined || input.quota === undefined) return { canStore: true, reason: "estimate-unavailable" };
  const free = input.quota - input.usage - STORAGE_HEADROOM_BYTES;
  return free >= input.size ? { canStore: true, reason: "enough-space" } : { canStore: false, reason: "insufficient-space" };
}

export function isQuotaExceededError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED" || /quota/i.test(error.message);
}
