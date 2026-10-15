import { createDomainEvent } from '../spider/events.js';
import { reduce, initialState } from './reducer.js';
import { demoIndex, resolve } from './demo-adapter.js';
import { addRecords, firstNeighborhood, expandStep, hiddenNeighborCount, neighborsOf } from '../model/queries.js';
import { BITCOIN, fetchAddress, normalizeAddress, walletId } from './bitcoin-adapter.js';
import { TYPE_LABEL } from '../model/model.js';

const DEMO_EXPAND_LIMIT = 2;
const DEMO_SOURCE_ID = 'demo:source:dataset';

let investigationCounter = 0;

export function createController({ bus, delay = 140, fetchImpl = globalThis.fetch }) {
  let state = initialState;
  let runToken = 0;
  let origin = 'demo';
  const subscribers = new Set();
  const loadedLive = new Map();
  const liveOrder = new Map();

  bus.on('*', (event) => {
    state = reduce(state, event);
    for (const subscriber of subscribers) subscriber(state);
  });

  const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
  const display = (id) => demoIndex.entities.get(id)?.display ?? id;
  const describe = (relationship) =>
    `Connection: ${display(relationship.sourceEntityId)} to ${display(relationship.targetEntityId)} (${(TYPE_LABEL[relationship.type] ?? relationship.type).toLowerCase()})`;

  function emit(type, payload) {
    bus.emit(createDomainEvent(type, { investigationId: state.investigationId ?? `inv-${investigationCounter}`, origin, payload }));
  }

  async function revealNeighbors(entityId, token, limit, order) {
    const visible = new Set(state.entityIds);
    const step = expandStep(demoIndex, visible, entityId, limit, order);
    const total = neighborsOf(demoIndex, entityId).length;
    if (step.add.length === 0) {
      emit('graph.neighborhood.expanded', {
        entityId, display: display(entityId), shownCount: total, totalCount: total, hiddenCount: 0,
        summary: `${display(entityId)} has no more connections in this data`,
      });
      return;
    }
    for (const id of step.add) {
      if (token !== runToken) return;
      emit('entity.discovered', { entityId: id, summary: `Found: ${display(id)}` });
      await wait(delay);
    }
    for (const relationshipId of step.relationshipIds) {
      if (token !== runToken) return;
      emit('relationship.discovered', { relationshipId, summary: describe(demoIndex.relationships.get(relationshipId)) });
      await wait(delay / 2);
    }
    const shown = total - step.hiddenCount;
    emit('graph.neighborhood.expanded', {
      entityId, display: display(entityId), shownCount: shown, totalCount: total, hiddenCount: step.hiddenCount,
      summary: step.hiddenCount > 0
        ? `Expanded ${display(entityId)}: showing ${shown} of ${total} connections`
        : `Expanded ${display(entityId)}: all ${total} connections shown`,
    });
  }

  async function runDemo(token, result) {
    await wait(delay);
    if (token !== runToken) return;
    emit('input.resolved', { rootId: result.rootId, detected: result.detected.label, summary: `Resolved to ${display(result.rootId)} in the demonstration dataset` });
    emit('source.requested', { sourceId: DEMO_SOURCE_ID, summary: 'Reading the demonstration dataset' });
    await wait(delay);
    emit('source.observed', { sourceId: DEMO_SOURCE_ID, summary: 'Demonstration dataset read (fictional data)' });

    const neighborhood = firstNeighborhood(demoIndex, result.rootId);
    const announced = new Set();
    for (const entityId of neighborhood.entityIds) {
      if (token !== runToken) return;
      emit('entity.discovered', { entityId, summary: `${entityId === result.rootId ? 'Root' : 'Found'}: ${display(entityId)}` });
      announced.add(entityId);
      for (const relationshipId of neighborhood.relationshipIds) {
        const relationship = demoIndex.relationships.get(relationshipId);
        const ready = announced.has(relationship.sourceEntityId) && announced.has(relationship.targetEntityId);
        if (ready && !state.relationshipIds.includes(relationshipId)) {
          emit('relationship.discovered', { relationshipId, summary: describe(relationship) });
        }
      }
      await wait(delay);
    }
    emit('graph.neighborhood.expanded', {
      entityId: result.rootId, display: display(result.rootId), shownCount: neighborhood.entityIds.length - 1,
      totalCount: neighborhood.entityIds.length - 1, hiddenCount: 0, summary: `Showing all ${neighborhood.entityIds.length - 1} connections of ${display(result.rootId)}`,
    });
    emit('investigation.completed', { summary: 'Demonstration run finished. Nothing above is real market or chain data.' });
  }

  async function loadBitcoin(address, token) {
    const key = walletId(address);
    if (loadedLive.has(key)) return loadedLive.get(key);
    emit('source.requested', { sourceId: BITCOIN.sourceId, summary: `Reading Blockstream (public Bitcoin API) for ${display(key)}` });
    const raw = await fetchAddress(address, fetchImpl);
    if (token !== runToken) return null;
    const records = normalizeAddress(address, raw);
    addRecords(demoIndex, records);
    loadedLive.set(key, records);
    liveOrder.set(key, records.counterpartyOrder);
    emit('source.observed', {
      sourceId: BITCOIN.sourceId,
      summary: `Read ${raw.txs.length} recent transactions of ${raw.stats.chain_stats?.tx_count ?? '?'} for ${display(key)}`,
    });
    return records;
  }

  async function runBitcoin(token, result) {
    const rootId = walletId(result.address);
    emit('input.resolved', { rootId, detected: result.detected.label, summary: 'Resolved to a Bitcoin mainnet address' });
    try {
      const records = await loadBitcoin(result.address, token);
      if (!records || token !== runToken) return;
    } catch (error) {
      emit('agent.blocked', { summary: `Could not read Bitcoin data: ${error.message}. Nothing was changed; try again in a moment.` });
      return;
    }
    emit('entity.discovered', { entityId: rootId, summary: `Root: ${display(rootId)}` });
    await revealNeighbors(rootId, token, BITCOIN.maxCounterparties, liveOrder.get(rootId));
    if (token !== runToken) return;
    emit('investigation.completed', { summary: 'Live data from the Bitcoin chain. Each connection links to its transaction.' });
  }

  async function open(rawInput) {
    const token = ++runToken;
    const input = rawInput.trim();
    investigationCounter += 1;
    const result = resolve(input);
    origin = result.status === 'live' ? 'live' : 'demo';
    bus.emit(createDomainEvent('investigation.started', {
      investigationId: `inv-${investigationCounter}`, origin, payload: { input, summary: `Investigation started: ${input || 'demo'}` },
    }));

    if (result.status === 'ambiguous') {
      emit('agent.needs_input', {
        input, candidates: result.candidates.slice(0, 8),
        summary: `"${input}" matches ${result.candidates.length} items in the demonstration dataset. Which did you mean?`,
      });
      return;
    }
    if (result.status === 'unsupported') {
      emit('input.unsupported', {
        input,
        summary: BITCOIN.enabled
          ? 'This kind of lead cannot be looked up yet. Bitcoin addresses and the demonstration dataset can be opened.'
          : 'No live data source is connected. Only the demonstration dataset can be opened.',
      });
      return;
    }
    if (result.status === 'live') return runBitcoin(token, result);
    return runDemo(token, result);
  }

  async function expand(entityId) {
    if (state.status !== 'ready' || !state.entityIds.includes(entityId)) return;
    const entity = demoIndex.entities.get(entityId);
    const token = ++runToken;
    if (entity.origin === 'live') {
      const address = entity.identifiers[0].value;
      try {
        const records = await loadBitcoin(address, token);
        if (!records || token !== runToken) return;
      } catch (error) {
        emit('agent.blocked', { summary: `Could not read Bitcoin data: ${error.message}. The graph is unchanged.` });
        return;
      }
      return revealNeighbors(entityId, token, BITCOIN.expandLimit, liveOrder.get(entityId));
    }
    emit('source.requested', { sourceId: DEMO_SOURCE_ID, summary: `Expanding ${display(entityId)}` });
    return revealNeighbors(entityId, token, DEMO_EXPAND_LIMIT, null);
  }

  return {
    get state() {
      return state;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },
    open,
    openDemo: () => open('demo'),
    expand,
    canExpand(entityId) {
      if (state.status !== 'ready') return false;
      const entity = demoIndex.entities.get(entityId);
      if (entity?.origin === 'live' && !loadedLive.has(entityId)) return true;
      return hiddenNeighborCount(demoIndex, new Set(state.entityIds), entityId) > 0;
    },
    selectEntity: (entityId) => emit('graph.node.selected', { entityId }),
    selectRelationship: (relationshipId) => emit('graph.edge.selected', { relationshipId, relationship: demoIndex.relationships.get(relationshipId) }),
    clearSelection: () => emit('graph.selection.cleared', {}),
    reset() {
      runToken += 1;
      emit('investigation.reset', {});
    },
  };
}
