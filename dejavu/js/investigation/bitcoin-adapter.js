import { idOf } from '../model/model.js';

export const BITCOIN = Object.freeze({
  enabled: true,
  apiBase: 'https://blockstream.info/api',
  explorerBase: 'https://blockstream.info',
  sourceId: 'btc:source:blockstream',
  maxCounterparties: 10,
  expandLimit: 8,
});

const SATS_PER_BTC = 100_000_000;
const LEGACY = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BECH32 = /^bc1[ac-hj-np-z02-9]{11,71}$/i;

export const isBitcoinAddress = (raw) => LEGACY.test(raw.trim()) || BECH32.test(raw.trim());

export const walletId = (address) => idOf('btc', 'wallet', address);
export const shortAddress = (address) => (address.length > 16 ? `${address.slice(0, 7)}…${address.slice(-6)}` : address);
const toBtc = (sats) => Math.round((sats / SATS_PER_BTC) * 1e8) / 1e8;

export const source = Object.freeze({
  id: BITCOIN.sourceId, providerId: 'blockstream', kind: 'chain_record',
  title: 'Blockstream Esplora API (Bitcoin mainnet)', reference: BITCOIN.apiBase,
  limitations: 'Public API. Returns the most recent transactions of an address (up to 25 confirmed plus pending).',
});

export async function fetchAddress(address, fetchImpl = globalThis.fetch) {
  const get = async (path) => {
    const response = await fetchImpl(`${BITCOIN.apiBase}${path}`);
    if (!response.ok) throw new Error(`Blockstream answered ${response.status}`);
    return response.json();
  };
  const [stats, txs] = await Promise.all([
    get(`/address/${encodeURIComponent(address)}`),
    get(`/address/${encodeURIComponent(address)}/txs`),
  ]);
  return { stats, txs };
}

function counterpartyAmounts(tx, address) {
  const inputs = tx.vin.map((input) => input.prevout?.scriptpubkey_address).filter(Boolean);
  const outputs = new Map();
  for (const output of tx.vout) {
    const to = output.scriptpubkey_address;
    if (to) outputs.set(to, (outputs.get(to) ?? 0) + output.value);
  }
  const senders = new Set(inputs);
  const pairs = [];
  if (senders.has(address)) {
    for (const [to, value] of outputs) if (to !== address) pairs.push({ from: address, to, value });
  }
  if (outputs.has(address)) {
    for (const from of senders) if (from !== address) pairs.push({ from, to: address, value: outputs.get(address) });
  }
  return pairs;
}

/** Pure: turns an address's transactions into model records. Every relationship is a direct
 *  observation that two addresses appear in one transaction (input side to output side). */
export function normalizeAddress(address, { stats, txs }, retrievedAt = new Date().toISOString()) {
  const entities = new Map();
  const relationships = new Map();
  const observations = [];
  const touch = (addr) => {
    if (!entities.has(addr)) {
      entities.set(addr, {
        id: walletId(addr), kind: 'wallet', display: shortAddress(addr), origin: 'live',
        identifiers: [{ type: 'bitcoin_address', value: addr }], freshness: 'fresh', attributes: {}, provenanceIds: [],
      });
    }
    return entities.get(addr);
  };

  const root = touch(address);
  const rootObservation = `btc:obs:address:${address}`;
  const balanceSats = (stats.chain_stats?.funded_txo_sum ?? 0) - (stats.chain_stats?.spent_txo_sum ?? 0);
  root.attributes.balance = { value: toBtc(balanceSats), unit: 'BTC', observedAt: retrievedAt, status: 'raw', provenanceIds: [rootObservation] };
  root.attributes.transactions = { value: stats.chain_stats?.tx_count ?? 0, observedAt: retrievedAt, status: 'raw', provenanceIds: [rootObservation] };
  root.provenanceIds.push(rootObservation);
  observations.push({
    id: rootObservation, sourceId: BITCOIN.sourceId, entityIds: [root.id], relationshipIds: [], retrievedAt,
    observedAt: retrievedAt, form: 'raw', status: 'ok', url: `${BITCOIN.explorerBase}/address/${address}`,
    limitation: `Based on the most recent ${txs.length} of ${stats.chain_stats?.tx_count ?? '?'} confirmed transactions.`,
  });

  for (const tx of txs) {
    const confirmed = Boolean(tx.status?.confirmed);
    const observationId = `btc:obs:tx:${tx.txid}`;
    const observedAt = confirmed && tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : undefined;
    const touched = [];
    for (const pair of counterpartyAmounts(tx, address)) {
      const from = touch(pair.from);
      const to = touch(pair.to);
      const id = `btc:rel:${pair.from}>${pair.to}`;
      const existing = relationships.get(id);
      const amount = toBtc(pair.value);
      if (existing) {
        existing.amount = Math.round((existing.amount + amount) * 1e8) / 1e8;
        existing.provenanceIds.push(observationId);
        if (observedAt && (!existing.observedAt || observedAt > existing.observedAt)) existing.observedAt = observedAt;
      } else {
        relationships.set(id, {
          id, sourceEntityId: from.id, targetEntityId: to.id, type: 'interacts_with', direction: 'directed',
          status: 'direct', origin: 'live', amount, unit: 'BTC', chainOrMarket: 'Bitcoin', observedAt,
          provenanceIds: [observationId],
        });
      }
      touched.push(id);
    }
    if (touched.length) {
      observations.push({
        id: observationId, sourceId: BITCOIN.sourceId, entityIds: [], relationshipIds: touched, retrievedAt, observedAt,
        form: 'raw', status: confirmed ? 'ok' : 'partial', payloadRef: tx.txid, url: `${BITCOIN.explorerBase}/tx/${tx.txid}`,
        limitation: confirmed ? undefined : 'Unconfirmed transaction; not treated as a final record.',
      });
    }
  }

  return {
    entities: [...entities.values()], relationships: [...relationships.values()], observations, sources: [source],
    counterpartyOrder: [...new Set([...relationships.values()].map((r) => (r.sourceEntityId === root.id ? r.targetEntityId : r.sourceEntityId)))],
  };
}
