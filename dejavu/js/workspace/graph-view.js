import { knownPosition, VIEW } from './demo-layout.js';
import { verification } from '../model/queries.js';
import { KIND_LABEL, TYPE_LABEL, STATUS_LABEL } from '../model/model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_RADIUS = 24;
const BRACKET_PAD = 10;
const BRACKET_ARM = 9;

const svgEl = (name, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};

function shapeFor(kind) {
  switch (kind) {
    case 'token':
      return svgEl('rect', { x: -18, y: -18, width: 36, height: 36, rx: 8 });
    case 'contract':
      return svgEl('polygon', { points: '0,-22 19,-11 19,11 0,22 -19,11 -19,-11' });
    case 'web_page':
      return svgEl('path', { d: 'M-15,-20 H8 L16,-12 V20 H-15 Z' });
    default:
      return svgEl('circle', { r: 19 });
  }
}

function truncate(text, max = 16) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function createGraphView({ svg, index, onSelectEntity, onSelectRelationship }) {
  svg.setAttribute('viewBox', `0 0 ${VIEW.width} ${VIEW.height}`);
  svg.replaceChildren();

  const defs = svgEl('defs');
  for (const status of ['direct', 'provider_labeled', 'derived', 'hypothesis']) {
    const marker = svgEl('marker', { id: `arrow-${status}`, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: `arrow arrow-${status}` }));
    defs.append(marker);
  }
  const edgeLayer = svgEl('g', { class: 'edges' });
  const nodeLayer = svgEl('g', { class: 'nodes' });
  const bracketLayer = svgEl('g', { class: 'brackets', 'aria-hidden': 'true' });
  svg.append(defs, edgeLayer, nodeLayer, bracketLayer);

  const nodes = new Map();
  const edges = new Map();
  let view = { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
  let selection = null;
  let rootId = null;
  const childCounts = new Map();

  function applyView() {
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`);
    const unitsPerPixel = view.width / (svg.clientWidth || VIEW.width);
    svg.style.setProperty('--ui-scale', String(Math.min(Math.max(unitsPerPixel, 1), 2.4).toFixed(2)));
  }

  function fit() {
    const points = [...nodes.values()].map((node) => node.position);
    if (points.length === 0) {
      view = { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
      return applyView();
    }
    const padX = 100;
    const padY = svg.clientWidth && svg.clientWidth < 520 ? 55 : 90;
    const minX = Math.min(...points.map((p) => p.x)) - padX;
    const maxX = Math.max(...points.map((p) => p.x)) + padX;
    const minY = Math.min(...points.map((p) => p.y)) - padY;
    const maxY = Math.max(...points.map((p) => p.y)) + padY;
    const aspect = svg.clientWidth && svg.clientHeight ? svg.clientWidth / svg.clientHeight : VIEW.width / VIEW.height;
    let width = maxX - minX;
    let height = maxY - minY;
    if (width / height < aspect) width = height * aspect;
    else height = width / aspect;
    view = { x: (minX + maxX) / 2 - width / 2, y: (minY + maxY) / 2 - height / 2, width, height };
    applyView();
  }

  function zoom(factor, center) {
    const cx = center?.x ?? view.x + view.width / 2;
    const cy = center?.y ?? view.y + view.height / 2;
    const width = Math.min(Math.max(view.width * factor, 160), VIEW.width * 4);
    const height = (width / view.width) * view.height;
    view = { x: cx - ((cx - view.x) / view.width) * width, y: cy - ((cy - view.y) / view.height) * height, width, height };
    applyView();
  }

  function focusRoot() {
    const node = nodes.get(rootId);
    if (!node) return;
    view = { x: node.position.x - view.width / 2, y: node.position.y - view.height / 2, width: view.width, height: view.height };
    applyView();
  }

  function toSvgPoint(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return { x: view.x + ((clientX - rect.left) / rect.width) * view.width, y: view.y + ((clientY - rect.top) / rect.height) * view.height };
  }

  function place(entityId, parentId) {
    const known = knownPosition(entityId);
    if (known) return known;
    const center = { x: VIEW.width / 2, y: VIEW.height * 0.56 };
    if (entityId === rootId || !parentId) return center;
    const parent = nodes.get(parentId)?.position ?? center;
    const fromRoot = parentId === rootId;
    const count = childCounts.get(parentId) ?? 0;
    childCounts.set(parentId, count + 1);
    const rootPosition = nodes.get(rootId)?.position ?? center;
    const outward = Math.atan2(parent.y - rootPosition.y, parent.x - rootPosition.x);
    for (let tries = 0; tries < 30; tries += 1) {
      const angle = fromRoot
        ? count * 2.39996 + tries * 0.37
        : outward + (count % 2 ? 1 : -1) * Math.ceil(count / 2) * 0.55 + tries * 0.37;
      const radius = (fromRoot ? 190 + 26 * Math.floor(count / 9) : 150) + tries * 6;
      const candidate = { x: parent.x + Math.cos(angle) * radius, y: parent.y + Math.sin(angle) * radius };
      if ([...nodes.values()].every((other) => Math.hypot(other.position.x - candidate.x, other.position.y - candidate.y) > 78)) return candidate;
    }
    return { x: parent.x + 200, y: parent.y + 40 * count };
  }

  function addNode(entityId, parentId) {
    const entity = index.entities.get(entityId);
    const position = place(entityId, parentId);
    const group = svgEl('g', {
      class: `ws-node kind-${entity.kind} enter`, tabindex: '0', role: 'button',
      'data-spider-id': `node:${entityId}`, 'data-entity-id': entityId,
      'aria-label': `${KIND_LABEL[entity.kind]} ${entity.display}, ${entity.origin === 'live' ? 'live data' : 'demonstration data'}`,
      transform: `translate(${position.x} ${position.y})`,
    });
    const shape = shapeFor(entity.kind);
    shape.setAttribute('class', 'node-shape');
    group.append(svgEl('circle', { class: 'node-hit', r: 30 }));
    const label = svgEl('text', { class: 'node-label', y: 40, 'text-anchor': 'middle' });
    label.textContent = truncate(entity.display);
    group.append(shape, label);
    if (entity.freshness !== 'fresh') {
      const flag = svgEl('text', { class: 'node-flag', x: 24, y: -16 });
      flag.textContent = entity.freshness === 'stale' ? 'stale' : '?';
      group.append(flag);
    }
    group.addEventListener('click', () => onSelectEntity(entityId));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelectEntity(entityId);
      }
    });
    nodeLayer.append(group);
    setTimeout(() => group.classList.remove('enter'), 700);
    nodes.set(entityId, { group, position });
    return group;
  }

  function edgeGeometry(relationship, siblings) {
    const from = nodes.get(relationship.sourceEntityId).position;
    const to = nodes.get(relationship.targetEntityId).position;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const start = { x: from.x + ux * (NODE_RADIUS + 2), y: from.y + uy * (NODE_RADIUS + 2) };
    const end = { x: to.x - ux * (NODE_RADIUS + 6), y: to.y - uy * (NODE_RADIUS + 6) };
    const bend = siblings > 1 ? 34 : 0;
    const control = { x: (start.x + end.x) / 2 - uy * bend, y: (start.y + end.y) / 2 + ux * bend };
    return { d: `M${start.x},${start.y} Q${control.x},${control.y} ${end.x},${end.y}`, mid: { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 } };
  }

  function addEdge(relationshipId) {
    const relationship = index.relationships.get(relationshipId);
    if (!nodes.has(relationship.sourceEntityId) || !nodes.has(relationship.targetEntityId)) return null;
    const siblings = [...index.relationships.values()].filter(
      (other) => [other.sourceEntityId, other.targetEntityId].sort().join() === [relationship.sourceEntityId, relationship.targetEntityId].sort().join(),
    ).length;
    const geometry = edgeGeometry(relationship, siblings);
    const source = index.entities.get(relationship.sourceEntityId).display;
    const target = index.entities.get(relationship.targetEntityId).display;
    const group = svgEl('g', {
      class: `ws-edge status-${relationship.status} enter`, tabindex: '0', role: 'button',
      'data-spider-id': `edge:${relationshipId}`, 'data-relationship-id': relationshipId,
      'aria-label': `${TYPE_LABEL[relationship.type]} between ${source} and ${target}, ${STATUS_LABEL[relationship.status]}, ${relationship.origin === 'live' ? 'live data' : 'demonstration data'}`,
    });
    const hit = svgEl('path', { class: 'edge-hit', d: geometry.d });
    const line = svgEl('path', { class: 'edge-line', d: geometry.d, pathLength: '1' });
    if (relationship.direction === 'directed') line.setAttribute('marker-end', `url(#arrow-${relationship.status})`);
    group.append(hit, line);
    if (relationship.amount != null) {
      const label = svgEl('text', { class: 'edge-label', x: geometry.mid.x, y: geometry.mid.y - 6, 'text-anchor': 'middle' });
      label.textContent = `${relationship.amount} ${relationship.unit ?? ''}`.trim();
      group.append(label);
    }
    group.addEventListener('click', () => onSelectRelationship(relationshipId));
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelectRelationship(relationshipId);
      }
    });
    edgeLayer.append(group);
    setTimeout(() => group.classList.remove('enter'), 700);
    edges.set(relationshipId, { group });
    return group;
  }

  function drawBrackets() {
    bracketLayer.replaceChildren();
    if (!selection) return;
    const target = selection.kind === 'entity' ? nodes.get(selection.id)?.group : edges.get(selection.id)?.group;
    if (!target) return;
    const box = target.getBBox();
    const matrix = selection.kind === 'entity' ? target.transform.baseVal.consolidate()?.matrix : null;
    const ox = matrix ? matrix.e : 0;
    const oy = matrix ? matrix.f : 0;
    const x0 = box.x + ox - BRACKET_PAD;
    const y0 = box.y + oy - BRACKET_PAD;
    const x1 = box.x + ox + box.width + BRACKET_PAD;
    const y1 = box.y + oy + box.height + BRACKET_PAD;
    const a = BRACKET_ARM;
    const path = [
      `M${x0},${y0 + a} V${y0} H${x0 + a}`, `M${x1 - a},${y0} H${x1} V${y0 + a}`,
      `M${x1},${y1 - a} V${y1} H${x1 - a}`, `M${x0 + a},${y1} H${x0} V${y1 - a}`,
    ].join(' ');
    bracketLayer.append(svgEl('path', { class: 'bracket-mark', d: path }));
  }

  function update({ entityIds, relationshipIds, selection: nextSelection, rootId: nextRoot, dimmed = new Set() }) {
    rootId = nextRoot;
    selection = nextSelection;

    for (const [id, node] of nodes) {
      if (!entityIds.includes(id)) {
        node.group.remove();
        nodes.delete(id);
      }
    }
    for (const [id, edge] of edges) {
      if (!relationshipIds.includes(id)) {
        edge.group.remove();
        edges.delete(id);
      }
    }
    const parentOf = (entityId) => {
      const link = [...index.relationships.values()].find(
        (relationship) => (relationship.sourceEntityId === entityId || relationship.targetEntityId === entityId) &&
          [relationship.sourceEntityId, relationship.targetEntityId].some((other) => other !== entityId && nodes.has(other)),
      );
      return link && (link.sourceEntityId === entityId ? link.targetEntityId : link.sourceEntityId);
    };
    if (entityIds.length === 0) childCounts.clear();
    for (const id of entityIds) if (!nodes.has(id)) addNode(id, parentOf(id));
    for (const id of relationshipIds) if (!edges.has(id)) addEdge(id);

    for (const [id, node] of nodes) {
      node.group.classList.toggle('is-root', id === rootId);
      node.group.classList.toggle('is-selected', selection?.kind === 'entity' && selection.id === id);
    }
    for (const [id, edge] of edges) {
      edge.group.classList.toggle('is-selected', selection?.kind === 'relationship' && selection.id === id);
      edge.group.classList.toggle('is-dimmed', dimmed.has(id));
      edge.group.classList.toggle('is-verified', verification(index, index.relationships.get(id)).verified);
    }
    const activeEdges = [...edges.keys()].filter((id) => !dimmed.has(id));
    const lit = new Set();
    for (const id of activeEdges) {
      const relationship = index.relationships.get(id);
      lit.add(relationship.sourceEntityId);
      lit.add(relationship.targetEntityId);
    }
    for (const [id, node] of nodes) node.group.classList.toggle('is-dimmed', dimmed.size > 0 && id !== rootId && !lit.has(id));
    drawBrackets();
  }

  let drag = null;
  svg.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.ws-node, .ws-edge')) return;
    drag = { x: event.clientX, y: event.clientY, view: { ...view } };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    view = {
      ...drag.view,
      x: drag.view.x - ((event.clientX - drag.x) / rect.width) * drag.view.width,
      y: drag.view.y - ((event.clientY - drag.y) / rect.height) * drag.view.height,
    };
    applyView();
  });
  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    svg.releasePointerCapture?.(event.pointerId);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.12 : 0.89, toSvgPoint(event.clientX, event.clientY));
  }, { passive: false });
  const resizeObserver = new ResizeObserver(() => drawBrackets());
  resizeObserver.observe(svg);

  return { update, fit, zoom, focusRoot, destroy: () => resizeObserver.disconnect() };
}
