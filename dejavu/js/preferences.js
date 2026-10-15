const CALM_KEY = 'opencrawl.calm';

function readStored() {
  try {
    const value = localStorage.getItem(CALM_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
}

export function createPreferences({ reducedMotion }) {
  const stored = readStored();
  let calm = stored ?? (reducedMotion || window.innerWidth < 720);
  const subscribers = new Set();

  return {
    get calm() {
      return calm;
    },
    setCalm(next) {
      calm = next;
      try {
        localStorage.setItem(CALM_KEY, next ? '1' : '0');
      } catch {
        // Preference stays in memory when storage is blocked.
      }
      for (const subscriber of subscribers) subscriber(calm);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}
