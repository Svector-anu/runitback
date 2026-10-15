import { KIND_LABEL, TYPE_LABEL, STATUS_LABEL, FORM_LABEL } from '../model/model.js';
import { neighborsOf, observationsOf, verification } from '../model/queries.js';

const timeFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const formatTime = (iso) => (iso ? `${timeFormat.format(new Date(iso))} UTC` : 'not available');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const REASON_LABEL = {
  'origin-not-live': 'it is not live data',
  'status-not-direct': 'it is not a direct observation',
  'endpoint-not-live': 'an endpoint is not live data',
  'no-primary-observation': 'there is no confirmed primary record',
  'source-unresolvable': 'its source cannot be opened',
  stale: 'the data is older than the freshness limit',
  conflict: 'sources disagree',
};

const originChip = (record) => (record.origin === 'live' ? chip('Live', 'chip-ok') : chip('Demo', 'chip-demo'));

function chip(text, className = '') {
  return el('span', `chip ${className}`.trim(), text);
}

function section(title, ...children) {
  const wrapper = el('section', 'ins-section');
  wrapper.append(el('h3', 'ins-heading', title), ...children);
  return wrapper;
}

function row(label, value) {
  const wrapper = el('div', 'ins-row');
  wrapper.append(el('dt', '', label), el('dd', '', value));
  return wrapper;
}

function linkRow(label, url) {
  const wrapper = el('div', 'ins-row');
  const link = el('a', 'ext-link', url.replace('https://', ''));
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  wrapper.append(el('dt', '', label), link);
  return wrapper;
}

function definition(...rows) {
  const list = el('dl', 'ins-list');
  list.append(...rows);
  return list;
}

function copyButton(value) {
  const button = el('button', 'btn-quiet', 'Copy');
  button.type = 'button';
  button.setAttribute('aria-label', `Copy ${value}`);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1400);
  });
  return button;
}

function provenanceList(index, record) {
  const list = el('ul', 'prov-list');
  for (const observation of observationsOf(index, record)) {
    const source = index.sources.get(observation.sourceId);
    const item = el('li', 'prov-item');
    const details = el('details');
    const summary = el('summary', '', `${source.title}: ${FORM_LABEL[observation.form]}, retrieved ${formatTime(observation.retrievedAt)}`);
    details.append(summary, definition(
      row('Source kind', source.kind.replace(/_/g, ' ')),
      row('Reference', source.reference || 'not available'),
      row('Method', observation.method ?? 'none (direct record)'),
      row('Observed', formatTime(observation.observedAt)),
      row('Limitations', observation.limitation ?? source.limitations ?? 'none recorded'),
      ...(observation.url && observation.url.startsWith('https://') ? [linkRow('Open source', observation.url)] : []),
    ));
    item.append(details);
    list.append(item);
  }
  if (!list.children.length) list.append(el('li', 'empty', 'No provenance recorded.'));
  return list;
}

function connectedList(index, entityId, visibleIds, onSelectEntity) {
  const list = el('ul', 'conn-list');
  for (const { relationship, entity } of neighborsOf(index, entityId)) {
    const item = el('li');
    const button = el('button', 'btn-link', `${entity.display}`);
    button.type = 'button';
    button.disabled = !visibleIds.has(entity.id);
    button.addEventListener('click', () => onSelectEntity(entity.id));
    item.append(button, el('span', 'conn-meta', ` ${TYPE_LABEL[relationship.type].toLowerCase()}${visibleIds.has(entity.id) ? '' : ' (not in graph yet)'}`));
    list.append(item);
  }
  return list;
}

export function renderEntity(container, { index, entityId, visibleIds, canExpand, handlers }) {
  const entity = index.entities.get(entityId);
  const head = el('header', 'ins-head');
  const title = el('h2', 'ins-title', entity.display);
  const chips = el('div', 'chip-row');
  chips.append(chip(KIND_LABEL[entity.kind]), originChip(entity));
  if (entity.freshness !== 'fresh') chips.append(chip(entity.freshness === 'stale' ? 'Stale' : 'Unavailable', 'chip-warn'));
  head.append(title, chips);

  const identifier = entity.identifiers[0];
  const idRow = el('div', 'id-row');
  idRow.append(el('code', 'mono', identifier ? identifier.value : entity.id), copyButton(identifier ? identifier.value : entity.id));

  const attributes = Object.entries(entity.attributes).map(([name, attribute]) =>
    row(name[0].toUpperCase() + name.slice(1), `${attribute.value}${attribute.unit ? ` ${attribute.unit}` : ''} (observed ${formatTime(attribute.observedAt)})`),
  );
  if (!entity.attributes.balance && entity.kind === 'wallet') attributes.push(row('Balance', 'not available'));

  const actions = el('div', 'ins-actions');
  const expand = el('button', 'btn-primary', canExpand ? 'Expand connections' : 'All connections shown');
  expand.type = 'button';
  expand.disabled = !canExpand;
  expand.addEventListener('click', () => handlers.expand(entityId));
  const focus = el('button', 'btn-secondary', 'Focus in graph');
  focus.type = 'button';
  focus.addEventListener('click', () => handlers.focus(entityId));
  actions.append(expand, focus);

  container.replaceChildren(
    head, idRow,
    definition(row('Last seen', formatTime(entity.lastSeen)), row('Data origin', entity.origin === 'live' ? 'Live data: Bitcoin mainnet through the Blockstream API' : 'Demonstration data'), ...attributes),
    section('Connected entities', connectedList(index, entityId, visibleIds, handlers.selectEntity)),
    section('Provenance', provenanceList(index, entity)),
    actions,
  );
}

export function renderRelationship(container, { index, relationshipId, handlers }) {
  const relationship = index.relationships.get(relationshipId);
  const source = index.entities.get(relationship.sourceEntityId);
  const target = index.entities.get(relationship.targetEntityId);
  const verdict = verification(index, relationship);

  const head = el('header', 'ins-head');
  const chips = el('div', 'chip-row');
  chips.append(chip(STATUS_LABEL[relationship.status]), originChip(relationship));
  chips.append(chip(verdict.verified ? 'Verified' : 'Not verified', verdict.verified ? 'chip-ok' : 'chip-quiet'));
  head.append(el('h2', 'ins-title', TYPE_LABEL[relationship.type]), chips);

  const endpoints = el('div', 'endpoints');
  const a = el('button', 'btn-link', source.display);
  const b = el('button', 'btn-link', target.display);
  for (const [button, entity] of [[a, source], [b, target]]) {
    button.type = 'button';
    button.addEventListener('click', () => handlers.selectEntity(entity.id));
  }
  endpoints.append(a, el('span', 'arrow-glyph', relationship.direction === 'directed' ? ' to ' : ' and '), b);

  const rows = [
    row('Direction', relationship.direction === 'directed' ? 'Directed' : 'Undirected'),
    row('Amount', relationship.amount != null ? `${relationship.amount} ${relationship.unit ?? ''}`.trim() : 'not available'),
    row('Observed', formatTime(relationship.observedAt)),
    row('Network', relationship.chainOrMarket ?? 'not available'),
    row('Verification', verdict.verified
      ? 'Verified: a direct, confirmed record from a primary source, within the freshness limit'
      : relationship.origin === 'live'
        ? `Not verified: ${verdict.failed.map((reason) => REASON_LABEL[reason] ?? reason).join('; ')}`
        : 'Not verified: demonstration data is never verified'),
    row('Confidence', 'Not scored (no documented method)'),
  ];

  const conflicts = (relationship.conflicts ?? []).map((conflict) => {
    const box = el('div', 'conflict');
    box.append(el('strong', '', `Sources disagree about ${conflict.attribute}`));
    const list = el('ul');
    for (const entry of conflict.observations) {
      const observation = index.observations.get(entry.id);
      list.append(el('li', '', `${entry.value}: retrieved ${formatTime(observation.retrievedAt)}`));
    }
    box.append(list);
    return box;
  });

  container.replaceChildren(
    head, endpoints, definition(...rows),
    ...(conflicts.length ? [section('Conflicts', ...conflicts)] : []),
    section('Evidence', provenanceList(index, relationship)),
  );
}

export function renderEmpty(container) {
  const message = el('p', 'empty', 'Select a node or a connection to see what it is and where the information comes from.');
  container.replaceChildren(el('h2', 'ins-title', 'Inspector'), message);
}
