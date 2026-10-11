import { isSafeFontFamily } from "#/engine/model";

export const SYSTEM_FONTS = [
  "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "monospace", "sans-serif", "serif",
] as const;

/** Families shipped with the app as same-origin `@font-face` rules (public/fonts). No font is ever fetched from a third party. */
export const BUNDLED_FONTS = ["Inter"] as const;

/** A font that has not settled by now is abandoned; rendering falls back to the generic family meanwhile. */
export const FONT_LOAD_TIMEOUT_MS = 3_000;

export function isSystemFont(family: string): boolean {
  return (SYSTEM_FONTS as readonly string[]).includes(family);
}

export function isBundledFont(family: string): boolean {
  return (BUNDLED_FONTS as readonly string[]).includes(family);
}

const loaded = new Map<string, Promise<boolean>>();

function loadBundled(family: string, timeoutMs: number): Promise<boolean> {
  const fonts = document.fonts;
  if (!fonts) return Promise.resolve(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const ready = Promise.all([fonts.load(`400 16px "${family}"`), fonts.load(`700 16px "${family}"`)]).then(
    (faces) => faces.every((face) => face.length > 0),
    () => false,
  );
  return Promise.race([ready, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Makes a bundled family ready for canvas text. System families and any family that is not bundled resolve to false
 * (the generic family is used) and make no request: font names come from project files and agents, so they must
 * never reach the network. Never rejects and never takes longer than `timeoutMs`; failures are not cached.
 */
export function loadFont(family: string, timeoutMs: number = FONT_LOAD_TIMEOUT_MS): Promise<boolean> {
  if (typeof document === "undefined" || !isSafeFontFamily(family) || !isBundledFont(family)) return Promise.resolve(false);
  const existing = loaded.get(family);
  if (existing) return existing;
  const attempt = loadBundled(family, timeoutMs).then((ok) => {
    if (!ok) loaded.delete(family);
    return ok;
  });
  loaded.set(family, attempt);
  return attempt;
}
