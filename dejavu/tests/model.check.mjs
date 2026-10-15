import assert from 'node:assert/strict';
import { demoDataset, DEMO_ROOT_ID } from '../js/model/demo-dataset.js';
import { buildIndex, firstNeighborhood, expandStep, verification, neighborsOf } from '../js/model/queries.js';
import { createEventBus, DOMAIN_EVENT_TYPES } from '../js/spider/events.js';
import { createController } from '../js/investigation/controller.js';
import { detectInput, resolve } from '../js/investigation/demo-adapter.js';
import { createRecents } from '../js/investigation/recents.js';
import { isBitcoinAddress, normalizeAddress, walletId } from '../js/investigation/bitcoin-adapter.js';
import { addRecords } from '../js/model/queries.js';
import { demoIndex } from '../js/investigation/demo-adapter.js';

const index = buildIndex(demoDataset);
let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok  ${name}`);
};

check('dataset ids are unique and endpoints exist', () => {
  const ids = demoDataset.entities.map((entity) => entity.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const relationship of demoDataset.relationships) {
    assert.ok(index.entities.has(relationship.sourceEntityId), relationship.id);
    assert.ok(index.entities.has(relationship.targetEntityId), relationship.id);
    for (const id of relationship.provenanceIds) assert.ok(index.observations.has(id), `${relationship.id} ${id}`);
  }
  for (const observation of demoDataset.observations) assert.ok(index.sources.has(observation.sourceId));
});

check('everything in the demo dataset is labeled demo', () => {
  for (const record of [...demoDataset.entities, ...demoDataset.relationships]) assert.equal(record.origin, 'demo');
});

check('demo relationships can never be verified', () => {
  for (const relationship of demoDataset.relationships) {
    const result = verification(index, relationship);
    assert.equal(result.verified, false);
    assert.ok(result.failed.includes('origin-not-live'));
  }
});

check('verification passes only when every condition holds', () => {
  const live = {
    entities: [
      { id: 'a', origin: 'live', provenanceIds: [] },
      { id: 'b', origin: 'live', provenanceIds: [] },
    ],
    relationships: [{
      id: 'r', sourceEntityId: 'a', targetEntityId: 'b', origin: 'live', status: 'direct', provenanceIds: ['o'], conflicts: [],
    }],
    observations: [{ id: 'o', sourceId: 's', form: 'raw', status: 'ok', retrievedAt: new Date(1000).toISOString() }],
    sources: [{ id: 's', kind: 'chain_record', reference: 'tx:0x1@block:1' }],
  };
  const make = (patch = {}) => {
    const copy = structuredClone(live);
    patch(copy);
    return buildIndex({ rootId: 'a', version: 't', ...copy });
  };
  const now = 1000 + 1000;
  const verdict = (patch) => {
    const i = make(patch);
    return verification(i, i.relationships.get('r'), { now, maxAgeMs: 5000 });
  };
  assert.deepEqual(verdict(() => {}), { verified: true, failed: [] });
  assert.ok(verdict((d) => { d.relationships[0].status = 'derived'; }).failed.includes('status-not-direct'));
  assert.ok(verdict((d) => { d.relationships[0].status = 'provider_labeled'; }).failed.includes('status-not-direct'));
  assert.ok(verdict((d) => { d.sources[0].kind = 'provider_api'; }).failed.includes('no-primary-observation'));
  assert.ok(verdict((d) => { d.observations[0].form = 'derived'; }).failed.includes('no-primary-observation'));
  assert.ok(verdict((d) => { d.sources[0].reference = ''; }).failed.includes('source-unresolvable'));
  assert.ok(verdict((d) => { d.observations[0].retrievedAt = new Date(0).toISOString(); }).verified === true);
  assert.ok(
    (() => {
      const i = make(() => {});
      return verification(i, i.relationships.get('r'), { now: 1000 + 10000, maxAgeMs: 5000 }).failed.includes('stale');
    })(),
  );
  assert.ok(verdict((d) => { d.observations[0].status = 'partial'; }).failed.includes('no-primary-observation'));
  assert.ok(verdict((d) => { d.relationships[0].conflicts = [{ attribute: 'amount' }]; }).failed.includes('conflict'));
  assert.ok(verdict((d) => { d.entities[1].origin = 'demo'; }).failed.includes('endpoint-not-live'));
});

check('first neighborhood of the root', () => {
  const hood = firstNeighborhood(index, DEMO_ROOT_ID);
  assert.equal(hood.entityIds.length, 7);
  assert.equal(hood.entityIds[0], DEMO_ROOT_ID);
  assert.ok(hood.relationshipIds.includes('demo:rel:r14'), 'induced edge between two neighbors');
});

check('expansion is capped and reports hidden connections', () => {
  const visible = new Set(firstNeighborhood(index, DEMO_ROOT_ID).entityIds);
  const w2 = 'demo:wallet:w2';
  const first = expandStep(index, visible, w2, 2);
  assert.equal(first.add.length, 2);
  assert.equal(first.hiddenCount, 1);
  const next = new Set([...visible, ...first.add]);
  const second = expandStep(index, next, w2, 2);
  assert.equal(second.add.length, 1);
  assert.equal(second.hiddenCount, 0);
  assert.equal(neighborsOf(index, w2).length, 4);
});

check('input detection', () => {
  assert.equal(detectInput('').kind, 'empty');
  assert.equal(detectInput('Demo').kind, 'demo');
  assert.equal(detectInput('NVDA').kind, 'ticker');
  assert.equal(detectInput(`0x${'a'.repeat(40)}`).kind, 'address');
  assert.equal(detectInput('https://example.com').kind, 'url');
});

check('ambiguous input offers candidates, single match resolves', () => {
  const tokens = resolve('token');
  assert.equal(tokens.status, 'ambiguous');
  assert.equal(tokens.candidates.length, 2);
  assert.equal(resolve('demoa').status, 'resolved');
  assert.equal(resolve('zzzzzz').status, 'unsupported');
});

check('recents keep five, newest first, no duplicates', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const recents = createRecents(storage);
  for (const input of ['a', 'b', 'c', 'd', 'e', 'f', 'c']) recents.add(input);
  assert.deepEqual(recents.list().map((item) => item.input), ['c', 'f', 'e', 'd', 'b']);
  recents.clear();
  assert.equal(recents.list().length, 0);
});

const ROOT = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const PEER1 = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const PEER2 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const fixture = {
  stats: { chain_stats: { tx_count: 3, funded_txo_sum: 500000000, spent_txo_sum: 100000000 } },
  txs: [
    { txid: 'a'.repeat(64), status: { confirmed: true, block_height: 800000, block_time: 1_690_000_000 },
      vin: [{ prevout: { scriptpubkey_address: ROOT, value: 300000000 } }],
      vout: [{ scriptpubkey_address: PEER1, value: 200000000 }, { scriptpubkey_address: ROOT, value: 99990000 }] },
    { txid: 'b'.repeat(64), status: { confirmed: true, block_height: 799000, block_time: 1_680_000_000 },
      vin: [{ prevout: { scriptpubkey_address: PEER2, value: 50000000 } }],
      vout: [{ scriptpubkey_address: ROOT, value: 49990000 }] },
    { txid: 'c'.repeat(64), status: { confirmed: false },
      vin: [{ prevout: { scriptpubkey_address: ROOT, value: 10000000 } }],
      vout: [{ scriptpubkey_address: PEER1, value: 9990000 }] },
  ],
};

check('bitcoin address detection', () => {
  assert.ok(isBitcoinAddress(ROOT));
  assert.ok(isBitcoinAddress(PEER2));
  assert.ok(!isBitcoinAddress('NVDA'));
  assert.ok(!isBitcoinAddress(`0x${'a'.repeat(40)}`));
});

check('bitcoin normalization builds direct, live relationships with provenance', () => {
  const records = normalizeAddress(ROOT, fixture, '2026-10-12T10:00:00.000Z');
  assert.equal(records.entities.length, 3);
  assert.ok(records.entities.every((entity) => entity.origin === 'live'));
  const toPeer1 = records.relationships.find((r) => r.id === `btc:rel:${ROOT}>${PEER1}`);
  assert.equal(toPeer1.amount, 2.0999);
  assert.equal(toPeer1.provenanceIds.length, 2);
  assert.ok(records.relationships.every((r) => r.status === 'direct' && r.origin === 'live'));
  const root = records.entities.find((entity) => entity.id === walletId(ROOT));
  assert.equal(root.attributes.balance.value, 4);
  assert.equal(records.counterpartyOrder[0], walletId(PEER1));
});

check('live relationships verify only with a fresh, confirmed primary record', () => {
  const retrievedAt = '2026-10-12T10:00:00.000Z';
  const records = normalizeAddress(ROOT, fixture, retrievedAt);
  addRecords(demoIndex, records);
  const now = Date.parse(retrievedAt) + 60_000;
  const confirmedOnly = demoIndex.relationships.get(`btc:rel:${PEER2}>${ROOT}`);
  assert.deepEqual(verification(demoIndex, confirmedOnly, { now }), { verified: true, failed: [] });
  assert.equal(verification(demoIndex, confirmedOnly, { now: Date.parse(retrievedAt) + 2 * 3600_000 }).verified, false);
  const mixed = demoIndex.relationships.get(`btc:rel:${ROOT}>${PEER1}`);
  assert.equal(verification(demoIndex, mixed, { now }).verified, true, 'one confirmed observation is enough');
  const unconfirmedIndex = buildIndex({
    rootId: 'x', version: 't', entities: records.entities, sources: records.sources,
    relationships: [{ ...mixed, provenanceIds: [`btc:obs:tx:${'c'.repeat(64)}`] }],
    observations: records.observations,
  });
  assert.equal(verification(unconfirmedIndex, unconfirmedIndex.relationships.get(mixed.id), { now }).verified, false);
});

const run = async () => {
  const bus = createEventBus(DOMAIN_EVENT_TYPES);
  const controller = createController({ bus, delay: 0 });

  await controller.open('NVDA');
  assert.equal(controller.state.status, 'unsupported');
  assert.equal(controller.state.entityIds.length, 0);
  passed += 1;
  console.log('ok  unsupported input shows no data and no fake investigation');

  await controller.openDemo();
  assert.equal(controller.state.status, 'ready');
  assert.equal(controller.state.entityIds.length, 7);
  assert.equal(controller.state.rootId, DEMO_ROOT_ID);
  assert.ok(controller.state.relationshipIds.length >= 6);
  passed += 1;
  console.log('ok  demo investigation reaches ready with the first neighborhood');

  await controller.expand('demo:wallet:w2');
  assert.equal(controller.state.entityIds.length, 9);
  assert.equal(controller.state.banner?.kind, 'partial');
  await controller.expand('demo:wallet:w2');
  assert.equal(controller.state.entityIds.length, 10);
  assert.equal(controller.state.banner, null);
  passed += 1;
  console.log('ok  expansion shows a partial banner, then completes');

  await controller.open('token');
  assert.equal(controller.state.status, 'needs_input');
  assert.equal(controller.state.candidates.length, 2);
  assert.equal(controller.state.entityIds.length, 0);
  passed += 1;
  console.log('ok  ambiguous input waits for the user and fetches nothing');
  await controller.openDemo();

  const liveBus = createEventBus(DOMAIN_EVENT_TYPES);
  const stub = async (url) => ({
    ok: true,
    json: async () => (String(url).endsWith('/txs') ? fixture.txs : fixture.stats),
  });
  const live = createController({ bus: liveBus, delay: 0, fetchImpl: stub });
  await live.open(ROOT);
  assert.equal(live.state.origin, 'live');
  assert.equal(live.state.status, 'ready');
  assert.equal(live.state.entityIds.length, 3);
  assert.equal(live.state.relationshipIds.length, 2);
  passed += 1;
  console.log('ok  live bitcoin flow reaches ready with 3 entities (stubbed network)');

  const failing = createController({ bus: createEventBus(DOMAIN_EVENT_TYPES), delay: 0, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await failing.open(`1BoatSLRHtKNngkdXEeobR76b53LETtpyT`);
  assert.equal(failing.state.status, 'error');
  assert.match(failing.state.banner.text, /503/);
  passed += 1;
  console.log('ok  provider failure becomes a visible error and changes nothing');

  controller.selectRelationship('demo:rel:r3');
  assert.deepEqual(controller.state.selection, { kind: 'relationship', id: 'demo:rel:r3' });
  controller.clearSelection();
  assert.equal(controller.state.selection, null);
  controller.reset();
  assert.equal(controller.state.status, 'empty');
  passed += 1;
  console.log('ok  selection and reset');

  console.log(`\n${passed} checks passed`);
};

await run();
