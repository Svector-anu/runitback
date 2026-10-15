import { idOf } from './model.js';

export const DEMO_VERSION = 'demo-v1';
export const DEMO_ROOT_ID = idOf('demo', 'wallet', 'w7');

const RETRIEVED_AT = '2026-10-01T09:00:00Z';
const entityId = (kind, value) => idOf('demo', kind, value);

export const sources = [
  {
    id: 'demo:source:dataset', providerId: 'demo', kind: 'demo_dataset', title: 'Demonstration dataset v1',
    reference: DEMO_VERSION, limitations: 'Fictional data written for demonstration. Not real chain or market data.',
  },
  {
    id: 'demo:source:labels', providerId: 'demo-labels', kind: 'demo_dataset', title: 'Demo label set (fictional)',
    reference: `${DEMO_VERSION}/labels`, limitations: 'Fictional labels. Stands in for a provider that attaches labels to addresses.',
  },
  {
    id: 'demo:source:page', providerId: 'demo-web', kind: 'web_page', title: 'Demo report page (fictional)',
    reference: `${DEMO_VERSION}/page-1`, limitations: 'Fictional page. No real URL.',
  },
];

export const observations = [];
let observationCounter = 0;

function observe(sourceId, fields = {}) {
  const id = `demo:obs:${++observationCounter}`;
  observations.push({
    id, sourceId, entityIds: [], relationshipIds: [], retrievedAt: RETRIEVED_AT, observedAt: RETRIEVED_AT,
    form: 'raw', status: 'ok', ...fields,
  });
  return id;
}

function wallet(value, display, extra = {}) {
  const id = entityId('wallet', value);
  const provenance = observe('demo:source:dataset', { entityIds: [id] });
  return {
    id, kind: 'wallet', display, origin: 'demo',
    identifiers: [{ type: 'demo_address', value: `demo-${value}` }],
    firstSeen: '2026-08-12T00:00:00Z', lastSeen: '2026-09-30T00:00:00Z', freshness: 'fresh',
    attributes: { chain: { value: 'Demo chain', observedAt: RETRIEVED_AT, status: 'raw', provenanceIds: [provenance] } },
    provenanceIds: [provenance], ...extra,
  };
}

function withBalance(entity, value, unit) {
  entity.attributes.balance = { value, unit, observedAt: RETRIEVED_AT, status: 'normalized', provenanceIds: entity.provenanceIds };
  return entity;
}

const w7 = withBalance(wallet('w7', 'Wallet w7'), 1840, 'DEMOA');
const w2 = withBalance(wallet('w2', 'Wallet w2'), 310, 'DEMOA');
const w3 = withBalance(wallet('w3', 'Wallet w3'), 95, 'DEMOA');
const w5 = withBalance(wallet('w5', 'Wallet w5'), 2200, 'DEMOA');
const w8 = withBalance(wallet('w8', 'Wallet w8'), 40, 'DEMOA');
const w9 = withBalance(wallet('w9', 'Wallet w9'), 120, 'DEMOA');
const w14 = wallet('w14', 'Wallet w14');
const w15 = withBalance(wallet('w15', 'Wallet w15'), 12, 'DEMOA');
const w11 = withBalance(
  wallet('w11', 'Wallet w11', { lastSeen: '2026-07-02T00:00:00Z', freshness: 'stale' }), 500, 'DEMOA',
);

function simple(kind, value, display, identifierType) {
  const id = entityId(kind, value);
  const provenance = observe(kind === 'web_page' ? 'demo:source:page' : 'demo:source:dataset', { entityIds: [id] });
  return {
    id, kind, display, origin: 'demo', identifiers: [{ type: identifierType, value: `demo-${value}` }],
    firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-09-30T00:00:00Z', freshness: 'fresh',
    attributes: {}, provenanceIds: [provenance],
  };
}

export const entities = [
  w7, w2, w3, w5, w8, w9, w14, w15, w11,
  simple('token', 't1', 'Token DEMOA', 'demo_symbol'),
  simple('token', 't2', 'Token DEMOB', 'demo_symbol'),
  simple('contract', 'c1', 'Contract c1', 'demo_contract'),
  simple('web_page', 'p1', 'Demo report page', 'demo_page'),
];

export const relationships = [];

function relate(id, type, fromKind, from, toKind, to, fields = {}) {
  const source = entityId(fromKind, from);
  const target = entityId(toKind, to);
  const relationshipId = `demo:rel:${id}`;
  const provenance = fields.provenanceIds ?? [observe(fields.sourceId ?? 'demo:source:dataset', {
    relationshipIds: [relationshipId], form: fields.form ?? 'raw', method: fields.method,
  })];
  const { sourceId, form, method, ...rest } = fields;
  relationships.push({
    id: relationshipId, sourceEntityId: source, targetEntityId: target, type, direction: 'directed',
    status: 'direct', origin: 'demo', observedAt: RETRIEVED_AT, provenanceIds: provenance, ...rest,
  });
}

relate('r1', 'transfer', 'wallet', 'w7', 'wallet', 'w2', { amount: 120, unit: 'DEMOA', chainOrMarket: 'Demo chain' });
relate('r2', 'transfer', 'wallet', 'w7', 'wallet', 'w3', { amount: 45, unit: 'DEMOA', chainOrMarket: 'Demo chain' });
{
  const a = observe('demo:source:dataset', { relationshipIds: ['demo:rel:r3'], payloadRef: 'demo-tx-x1' });
  const b = observe('demo:source:dataset', { relationshipIds: ['demo:rel:r3'], payloadRef: 'demo-tx-x1-copy', retrievedAt: '2026-10-01T09:05:00Z' });
  relate('r3', 'transfer', 'wallet', 'w5', 'wallet', 'w7', {
    amount: 300, unit: 'DEMOA', chainOrMarket: 'Demo chain', provenanceIds: [a, b],
    conflicts: [{ attribute: 'amount', observations: [{ id: a, value: 300 }, { id: b, value: 310 }] }],
  });
}
relate('r4', 'interacts_with', 'wallet', 'w7', 'contract', 'c1', { chainOrMarket: 'Demo chain' });
relate('r5', 'holds', 'wallet', 'w7', 'token', 't1', {
  status: 'derived', form: 'derived', method: 'balance snapshot', amount: 1840, unit: 'DEMOA',
});
relate('r6', 'associated_with', 'wallet', 'w7', 'wallet', 'w11', { status: 'provider_labeled', sourceId: 'demo:source:labels' });
relate('r7', 'transfer', 'wallet', 'w2', 'wallet', 'w9', { amount: 60, unit: 'DEMOA', chainOrMarket: 'Demo chain' });
relate('r8', 'transfer', 'wallet', 'w2', 'wallet', 'w14', { amount: 15, unit: 'DEMOA', chainOrMarket: 'Demo chain' });
relate('r9', 'temporal_correlation', 'wallet', 'w3', 'wallet', 'w9', {
  status: 'hypothesis', direction: 'undirected', form: 'inferred', method: 'activity within the same hour',
});
relate('r10', 'same_source_mention', 'wallet', 'w3', 'web_page', 'p1', {
  status: 'derived', direction: 'undirected', form: 'derived', method: 'text match', sourceId: 'demo:source:page',
});
relate('r11', 'transfer', 'contract', 'c1', 'wallet', 'w8', { amount: 80, unit: 'DEMOA', chainOrMarket: 'Demo chain' });
relate('r12', 'interacts_with', 'contract', 'c1', 'token', 't2', { chainOrMarket: 'Demo chain' });
relate('r13', 'transfer', 'wallet', 'w8', 'wallet', 'w9', { amount: 30, unit: 'DEMOA', chainOrMarket: 'Demo chain' });
relate('r14', 'interacts_with', 'wallet', 'w5', 'contract', 'c1', { chainOrMarket: 'Demo chain' });
relate('r15', 'transfer', 'wallet', 'w2', 'wallet', 'w15', { amount: 10, unit: 'DEMOA', chainOrMarket: 'Demo chain' });

export const demoDataset = Object.freeze({ version: DEMO_VERSION, rootId: DEMO_ROOT_ID, entities, relationships, observations, sources });
