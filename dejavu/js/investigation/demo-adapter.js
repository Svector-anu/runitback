import { demoDataset, DEMO_ROOT_ID } from '../model/demo-dataset.js';
import { buildIndex } from '../model/queries.js';
import { BITCOIN, isBitcoinAddress } from './bitcoin-adapter.js';

export const demoIndex = buildIndex(demoDataset);

const DEMO_ALIASES = new Set(['demo', 'demo-v1', 'demo investigation', 'open the demo']);

function normalize(raw) {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function detectInput(raw) {
  const value = normalize(raw);
  if (!value) return { kind: 'empty', label: '' };
  if (DEMO_ALIASES.has(value)) return { kind: 'demo', label: 'Demo investigation' };
  if (demoIndex.entities.has(raw.trim())) return { kind: 'demo-entity', label: 'Demo entity' };
  if (BITCOIN.enabled && isBitcoinAddress(raw)) return { kind: 'bitcoin-address', label: 'Bitcoin address' };
  if (/^0x[0-9a-f]{40}$/i.test(value)) return { kind: 'address', label: 'Address, network unknown' };
  if (/^0x[0-9a-f]{64}$/i.test(value)) return { kind: 'transaction', label: 'Transaction hash' };
  if (/^https?:\/\//.test(value)) return { kind: 'url', label: 'URL' };
  if (/^[a-z]{1,5}$/.test(value)) return { kind: 'ticker', label: 'Ticker or symbol' };
  return { kind: 'text', label: 'Text' };
}

/** Resolves a raw lead: Bitcoin addresses go to the live adapter, everything else to the demo dataset. */
export function resolve(raw) {
  const detected = detectInput(raw);
  if (detected.kind === 'bitcoin-address') return { status: 'live', address: raw.trim(), detected };
  if (detected.kind === 'demo') return { status: 'resolved', rootId: DEMO_ROOT_ID, detected };
  if (detected.kind === 'demo-entity') return { status: 'resolved', rootId: raw.trim(), detected };
  const byName = [...demoIndex.entities.values()].find((entity) => normalize(entity.display) === normalize(raw));
  if (byName) return { status: 'resolved', rootId: byName.id, detected };
  const needle = normalize(raw);
  if (needle.length >= 3) {
    const matches = [...demoIndex.entities.values()].filter((entity) => normalize(entity.display).includes(needle));
    if (matches.length === 1) return { status: 'resolved', rootId: matches[0].id, detected };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches.map((entity) => entity.id), detected };
  }
  return { status: 'unsupported', detected };
}
