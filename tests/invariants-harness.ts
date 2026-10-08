import { expect } from "vitest";
import { assertDocumentInvariants } from "#/engine/timeline";
import type { Editor } from "#/engine/editor";

/** Deterministic PRNG so a failing seed reproduces exactly. */
export function makeRng(seed: number): { next(): number; int(n: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean } {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p) => next() < p,
  };
}

function assertAllFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  }
}

/** Everything that must hold after every single operation, whether it succeeded or was rejected. */
export function assertEditorHealthy(editor: Editor, context: string): void {
  const { doc } = editor.getState();
  try {
    assertDocumentInvariants(doc);
    assertAllFinite(doc.scenes, "scenes");
    assertAllFinite(doc.settings, "settings");
    expect(Number.isFinite(editor.duration())).toBe(true);
    editor.toProject();
  } catch (error) {
    throw new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function snapshotForUndo(editor: Editor): string {
  const { doc } = editor.getState();
  return JSON.stringify({ scenes: doc.scenes, settings: doc.settings, currentSceneId: doc.currentSceneId });
}
