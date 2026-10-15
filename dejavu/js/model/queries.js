export const PRIMARY_SOURCE_KINDS = Object.freeze(['chain_record']);
export const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export function buildIndex(dataset) {
  const entities = new Map(dataset.entities.map((entity) => [entity.id, entity]));
  const relationships = new Map(dataset.relationships.map((relationship) => [relationship.id, relationship]));
  const observations = new Map(dataset.observations.map((observation) => [observation.id, observation]));
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));
  const adjacency = new Map();
  for (const relationship of dataset.relationships) {
    for (const endpoint of [relationship.sourceEntityId, relationship.targetEntityId]) {
      if (!adjacency.has(endpoint)) adjacency.set(endpoint, []);
      adjacency.get(endpoint).push(relationship);
    }
  }
  return { rootId: dataset.rootId, version: dataset.version, entities, relationships, observations, sources, adjacency };
}

export function addRecords(index, records) {
  for (const entity of records.entities ?? []) index.entities.set(entity.id, { ...index.entities.get(entity.id), ...entity });
  for (const source of records.sources ?? []) index.sources.set(source.id, source);
  for (const observation of records.observations ?? []) index.observations.set(observation.id, observation);
  for (const relationship of records.relationships ?? []) {
    const isNew = !index.relationships.has(relationship.id);
    index.relationships.set(relationship.id, relationship);
    if (!isNew) continue;
    for (const endpoint of [relationship.sourceEntityId, relationship.targetEntityId]) {
      if (!index.adjacency.has(endpoint)) index.adjacency.set(endpoint, []);
      index.adjacency.get(endpoint).push(relationship);
    }
  }
  return index;
}

export function otherEnd(relationship, entityId) {
  return relationship.sourceEntityId === entityId ? relationship.targetEntityId : relationship.sourceEntityId;
}

export function neighborsOf(index, entityId) {
  const links = index.adjacency.get(entityId) ?? [];
  return [...links]
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    .map((relationship) => ({ relationship, entity: index.entities.get(otherEnd(relationship, entityId)) }));
}

export function inducedRelationships(index, visibleIds) {
  return [...index.relationships.values()]
    .filter((relationship) => visibleIds.has(relationship.sourceEntityId) && visibleIds.has(relationship.targetEntityId))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function firstNeighborhood(index, rootId) {
  const visible = new Set([rootId]);
  for (const { entity } of neighborsOf(index, rootId)) visible.add(entity.id);
  return {
    entityIds: [...visible],
    relationshipIds: inducedRelationships(index, visible).map((relationship) => relationship.id),
  };
}

export function expandStep(index, visibleIds, entityId, limit, order = null) {
  const hidden = neighborsOf(index, entityId)
    .map(({ entity }) => entity.id)
    .filter((id, position, all) => !visibleIds.has(id) && all.indexOf(id) === position);
  if (order) hidden.sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  const add = hidden.slice(0, limit);
  const next = new Set([...visibleIds, ...add]);
  const known = new Set(inducedRelationships(index, visibleIds).map((relationship) => relationship.id));
  return {
    add,
    hiddenCount: hidden.length - add.length,
    relationshipIds: inducedRelationships(index, next)
      .map((relationship) => relationship.id)
      .filter((id) => !known.has(id)),
  };
}

export function hiddenNeighborCount(index, visibleIds, entityId) {
  return new Set(
    neighborsOf(index, entityId).map(({ entity }) => entity.id).filter((id) => !visibleIds.has(id)),
  ).size;
}

export function observationsOf(index, record) {
  return record.provenanceIds.map((id) => index.observations.get(id)).filter(Boolean);
}

export function verification(index, relationship, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const failed = [];
  const observed = observationsOf(index, relationship);
  const sourceOf = (observation) => index.sources.get(observation.sourceId);
  const source = index.entities.get(relationship.sourceEntityId);
  const target = index.entities.get(relationship.targetEntityId);

  if (relationship.origin !== 'live') failed.push('origin-not-live');
  if (relationship.status !== 'direct') failed.push('status-not-direct');
  if (!source || !target || source.origin !== 'live' || target.origin !== 'live') failed.push('endpoint-not-live');

  const primary = observed.filter(
    (observation) =>
      observation.status === 'ok' &&
      ['raw', 'normalized'].includes(observation.form) &&
      PRIMARY_SOURCE_KINDS.includes(sourceOf(observation)?.kind),
  );
  if (primary.length === 0) {
    failed.push('no-primary-observation');
  } else {
    if (!primary.some((observation) => sourceOf(observation)?.reference)) failed.push('source-unresolvable');
    if (!primary.some((observation) => now - Date.parse(observation.retrievedAt) <= maxAgeMs)) failed.push('stale');
  }
  if ((relationship.conflicts ?? []).length > 0) failed.push('conflict');

  return { verified: failed.length === 0, failed };
}
