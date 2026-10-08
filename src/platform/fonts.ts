import { isSafeFontFamily } from "#/engine/model";

export const SYSTEM_FONTS = [
  "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "monospace", "sans-serif", "serif",
] as const;

/** A font request that has not settled by now is abandoned; rendering falls back to the generic family meanwhile. */
export const FONT_LOAD_TIMEOUT_MS = 3_000;

const loaded = new Map<string, Promise<boolean>>();

export function isSystemFont(family: string): boolean {
  return (SYSTEM_FONTS as readonly string[]).includes(family);
}

function requestFont(family: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const link = document.createElement("link");
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) link.remove();
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;700&display=swap`;
    link.onload = () => {
      const fonts = document.fonts;
      if (!fonts) { settle(true); return; }
      void Promise.all([fonts.load(`400 16px "${family}"`), fonts.load(`700 16px "${family}"`)])
        .then(() => settle(true), () => settle(false));
    };
    link.onerror = () => settle(false);
    document.head.appendChild(link);
  });
}

/**
 * Loads a non-system family from Google Fonts on demand. Never rejects and never takes longer than `timeoutMs`:
 * offline, blocked or malformed requests resolve to false and the generic family is used. Failures are not
 * cached, so a later call (e.g. once the network is back) tries again. Unsafe names make no request at all.
 */
export function loadFont(family: string, timeoutMs: number = FONT_LOAD_TIMEOUT_MS): Promise<boolean> {
  if (isSystemFont(family) || typeof document === "undefined" || !isSafeFontFamily(family)) return Promise.resolve(false);
  const existing = loaded.get(family);
  if (existing) return existing;
  const attempt = requestFont(family, timeoutMs).then((ok) => {
    if (!ok) loaded.delete(family);
    return ok;
  });
  loaded.set(family, attempt);
  return attempt;
}
