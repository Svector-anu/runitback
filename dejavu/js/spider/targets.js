import { rectOf } from './geometry.js';

const EDGE_PAD = 62;
const CANDIDATES =
  '[data-spider-id], h1, h2, h3, a[href], button, input, .step, .cap';
const MIN_WIDTH = 28;
const MIN_HEIGHT = 12;

function isUsable(el, rect) {
  if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return false;
  if (el.closest('[hidden], [data-spider-ignore], .mobile-menu')) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function weightOf(el) {
  if (el.matches('h1, h2, .cta, .step')) return 3;
  if (el.matches('button, a[href], .cap')) return 2;
  return 1;
}

export function visibleTargets({ margin = 40 } = {}) {
  const viewHeight = window.innerHeight;
  return [...document.querySelectorAll(CANDIDATES)].filter((el) => {
    const rect = el.getBoundingClientRect();
    return (
      rect.bottom > margin &&
      rect.top < viewHeight - margin &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      isUsable(el, rect)
    );
  });
}

export function pickTarget(exclude) {
  const pool = visibleTargets().filter((el) => el !== exclude);
  const total = pool.reduce((sum, el) => sum + weightOf(el), 0);
  if (total === 0) return null;
  let roll = Math.random() * total;
  for (const el of pool) {
    roll -= weightOf(el);
    if (roll <= 0) return el;
  }
  return pool[pool.length - 1];
}

export function resolveTarget(target) {
  if (!target) return null;
  if (target.id) return document.querySelector(`[data-spider-id="${CSS.escape(target.id)}"]`);
  if (target.selector) {
    try {
      return document.querySelector(target.selector);
    } catch {
      return null;
    }
  }
  return null;
}

export function makeAnchor({ interior = false } = {}) {
  if (interior) return { fx: 0.15 + Math.random() * 0.7, fy: 0.35 + Math.random() * 0.3 };
  return { side: Math.random() < 0.5 ? -1 : 1, fy: 0.3 + Math.random() * 0.4 };
}

export function docPointAt(el, anchor) {
  const rect = rectOf(el);
  if ('side' in anchor) {
    const pad = Number(el.dataset.spiderPad) || EDGE_PAD;
    const x = anchor.side < 0 ? rect.left - pad : rect.right + pad;
    return {
      x: Math.min(Math.max(x, 36), window.innerWidth - 36) + window.scrollX,
      y: rect.top + rect.height * anchor.fy + window.scrollY,
    };
  }
  return {
    x: rect.left + rect.width * anchor.fx + window.scrollX,
    y: rect.top + rect.height * anchor.fy + window.scrollY,
  };
}

export function ensureVisible(el, { instant = false } = {}) {
  const rect = rectOf(el);
  const margin = 90;
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return false;
  const top = window.scrollY + rect.top - window.innerHeight * 0.38;
  window.scrollTo({ top: Math.max(0, top), behavior: instant ? 'auto' : 'smooth' });
  return true;
}
