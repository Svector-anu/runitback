export const SYSTEM_FONTS = [
  "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana", "Georgia", "monospace", "sans-serif", "serif",
] as const;

const loaded = new Map<string, Promise<void>>();

export function isSystemFont(family: string): boolean {
  return (SYSTEM_FONTS as readonly string[]).includes(family);
}

/** Loads non-system families from Google Fonts on demand. Failures fall back to the generic family silently. */
export function loadFont(family: string): Promise<void> {
  if (isSystemFont(family) || typeof document === "undefined") return Promise.resolve();
  let entry = loaded.get(family);
  if (!entry) {
    entry = new Promise<void>((resolve) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;700&display=swap`;
      link.onload = () => {
        void Promise.all([document.fonts.load(`400 16px "${family}"`), document.fonts.load(`700 16px "${family}"`)])
          .catch(() => undefined)
          .then(() => resolve());
      };
      link.onerror = () => resolve();
      document.head.appendChild(link);
    });
    loaded.set(family, entry);
  }
  return entry;
}
