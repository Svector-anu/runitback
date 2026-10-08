export type IdGenerator = () => string;

export const randomId: IdGenerator = () => globalThis.crypto.randomUUID();

/** Deterministic ids for tests: `id-1`, `id-2`, ... */
export function sequentialIds(prefix = "id"): IdGenerator {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
