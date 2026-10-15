const KEY = 'opencrawl.recent';
const LIMIT = 5;

export function createRecents(storage = globalThis.localStorage) {
  function read() {
    try {
      const parsed = JSON.parse(storage.getItem(KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.input === 'string') : [];
    } catch {
      return [];
    }
  }

  return {
    list: read,
    add(input) {
      const value = input.trim();
      if (!value) return read();
      const next = [{ input: value, ts: Date.now() }, ...read().filter((item) => item.input !== value)].slice(0, LIMIT);
      try {
        storage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Recents stay in memory only when storage is blocked.
      }
      return next;
    },
    clear() {
      try {
        storage.removeItem(KEY);
      } catch {
        // Nothing to clear when storage is blocked.
      }
    },
  };
}
