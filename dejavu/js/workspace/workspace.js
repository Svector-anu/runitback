import { demoIndex, detectInput } from '../investigation/demo-adapter.js';
import { createGraphView } from './graph-view.js';
import { renderEmpty, renderEntity, renderRelationship } from './inspector.js';
import { KIND_LABEL, TYPE_LABEL, STATUS_LABEL } from '../model/model.js';
import { verification } from '../model/queries.js';

const RUN_LABEL = { idle: 'Idle', resolving: 'Resolving', tracing: 'Tracing', completed: 'Completed', needs_input: 'Needs input' };

const $ = (selector, root = document) => root.querySelector(selector);

function timeLabel(ts, start) {
  const seconds = Math.max(0, Math.round((ts - start) / 1000));
  return `00:${String(seconds).padStart(2, '0')}`;
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

export function mountWorkspace({ controller, preferences, recents, onLayoutChange, intake }) {
  const root = $('#terminal');
  const form = $('#query-form');
  const input = $('#query-input');
  const detected = $('#detected-chip');
  const subject = $('#ws-subject');
  const runState = $('#run-state');
  const calmToggle = $('#calm-toggle');
  const log = $('#log');
  const question = $('#ws-question');
  const emptyBlock = $('#ws-empty');
  const unsupportedBlock = $('#ws-unsupported');
  const graphBlock = $('#ws-graph');
  const banner = $('#ws-banner');
  const inspector = $('#inspector-body');
  const listView = $('#ws-list');
  const listToggle = $('#toggle-list');
  const tabs = [...root.querySelectorAll('[data-pane-tab]')];
  const sheetClose = $('#sheet-close');
  const chooseBlock = $('#ws-choose');
  const timeline = $('#timeline');
  const findingsList = $('#findings');
  const filtersClear = $('#filters-clear');
  const filterCount = $('#filter-count');
  const filters = { types: new Set(), statuses: new Set() };

  const graph = createGraphView({
    svg: $('#graph'),
    index: demoIndex,
    onSelectEntity: (id) => controller.selectEntity(id),
    onSelectRelationship: (id) => controller.selectRelationship(id),
  });

  let sheetDismissed = false;
  let lastSelectionKey = null;
  let lastEntityCount = 0;
  let fitTimer = 0;
  let lastStatus = 'empty';

  function scheduleFit(state) {
    clearTimeout(fitTimer);
    if (state.entityIds.length === 0 || state.status === 'loading') {
      if (state.entityIds.length === 0) graph.fit();
      return;
    }
    fitTimer = setTimeout(() => graph.fit(), 220);
  }

  function setPane(pane) {
    root.dataset.pane = pane;
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.paneTab === pane));
    onLayoutChange?.();
  }
  for (const tab of tabs) tab.addEventListener('click', () => setPane(tab.dataset.paneTab));

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    if (intake?.isActive() && intake.handleSubmit(value)) return;
    controller.open(value);
  });
  input.addEventListener('input', () => {
    const result = intake?.isActive() ? intake.detect(input.value) : detectInput(input.value);
    detected.hidden = !result.label;
    detected.textContent = result.label;
  });
  $('#open-demo').addEventListener('click', () => controller.openDemo());
  $('#open-demo-2').addEventListener('click', () => controller.openDemo());
  $('#clear-input').addEventListener('click', () => {
    controller.reset();
    input.value = '';
    detected.hidden = true;
    input.focus();
  });

  $('#zoom-in').addEventListener('click', () => graph.zoom(0.8));
  $('#zoom-out').addEventListener('click', () => graph.zoom(1.25));
  $('#fit').addEventListener('click', () => graph.fit());
  $('#focus-root').addEventListener('click', () => graph.focusRoot());
  $('#clear-selection').addEventListener('click', () => controller.clearSelection());
  listToggle.addEventListener('click', () => {
    const open = listView.hidden;
    listView.hidden = !open;
    $('#graph').parentElement.hidden = open;
    listToggle.setAttribute('aria-pressed', String(open));
    listToggle.textContent = open ? 'Graph' : 'List';
  });
  sheetClose.addEventListener('click', () => {
    sheetDismissed = true;
    root.dataset.sheet = 'closed';
  });

  calmToggle.addEventListener('click', () => preferences.setCalm(!preferences.calm));
  preferences.subscribe((calm) => renderCalm(calm));
  function renderCalm(calm) {
    calmToggle.setAttribute('aria-pressed', String(calm));
    calmToggle.textContent = calm ? 'Spider: calm' : 'Spider: on';
  }
  renderCalm(preferences.calm);

  document.addEventListener('keydown', (event) => {
    if (root.hidden) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === '/' && !typing) {
      event.preventDefault();
      input.focus();
      return;
    }
    if (event.key === 'Escape') {
      if (typing) input.blur();
      controller.clearSelection();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (root.dataset.view === 'market' && !['c', 't'].includes(event.key)) return;
    const state = controller.state;
    if (event.key === 'f') graph.fit();
    else if (event.key === 'r') graph.focusRoot();
    else if (event.key === 'l') listToggle.click();
    else if (event.key === 'c') calmToggle.click();
    else if (event.key === 't') $('#timeline-toggle').click();
    else if (event.key === 'e' && state.selection?.kind === 'entity') controller.expand(state.selection.id);
  });

  function relationshipLabel(relationship) {
    const from = demoIndex.entities.get(relationship.sourceEntityId).display;
    const to = demoIndex.entities.get(relationship.targetEntityId).display;
    return `${from} to ${to}`;
  }

  function isDimmed(relationship) {
    return (filters.types.size > 0 && !filters.types.has(relationship.type)) ||
      (filters.statuses.size > 0 && !filters.statuses.has(relationship.status));
  }

  function filterActive() {
    return filters.types.size + filters.statuses.size > 0;
  }

  function buildFilterChips(container, entries, set, labels, ariaPrefix) {
    container.replaceChildren(
      ...entries.map((key) => {
        const button = textNode('button', 'filter-chip', labels[key]);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(set.has(key)));
        button.setAttribute('aria-label', `${ariaPrefix}: ${labels[key]}`);
        button.addEventListener('click', () => {
          if (set.has(key)) set.delete(key);
          else set.add(key);
          refresh();
        });
        return button;
      }),
    );
  }

  const presentTypes = [...new Set([...demoIndex.relationships.values()].map((relationship) => relationship.type))];
  const presentStatuses = [...new Set([...demoIndex.relationships.values()].map((relationship) => relationship.status))];

  function renderFilters() {
    buildFilterChips($('#filter-types'), presentTypes, filters.types, TYPE_LABEL, 'Type');
    buildFilterChips($('#filter-status'), presentStatuses, filters.statuses, STATUS_LABEL, 'Status');
    const count = filters.types.size + filters.statuses.size;
    filterCount.hidden = count === 0;
    filterCount.textContent = String(count);
    filtersClear.hidden = count === 0;
  }
  filtersClear.addEventListener('click', () => {
    filters.types.clear();
    filters.statuses.clear();
    refresh();
  });

  function renderFindings(state) {
    if (state.relationshipIds.length === 0) {
      findingsList.replaceChildren(textNode('li', 'empty', 'Connections the investigation finds are listed here, in the order they were found.'));
      return;
    }
    findingsList.replaceChildren(
      ...state.relationshipIds.map((id) => {
        const relationship = demoIndex.relationships.get(id);
        const item = document.createElement('li');
        item.className = isDimmed(relationship) ? 'is-dimmed' : '';
        const button = textNode('button', 'btn-link', relationshipLabel(relationship));
        button.type = 'button';
        button.addEventListener('click', () => controller.selectRelationship(id));
        const meta = document.createElement('span');
        meta.className = 'finding-meta';
        meta.append(textNode('span', 'chip', STATUS_LABEL[relationship.status]), textNode('span', `chip ${relationship.origin === 'live' ? 'chip-ok' : 'chip-demo'}`, relationship.origin === 'live' ? 'Live' : 'Demo'));
        if (verification(demoIndex, relationship).verified) meta.append(textNode('span', 'chip chip-ok', 'Verified'));
        item.append(button, meta);
        return item;
      }),
    );
  }

  function renderTimelineBar(state) {
    const last = state.log[state.log.length - 1];
    $('#timeline-latest').textContent = last ? last.summary : 'No events yet.';
    $('#timeline-count').textContent = state.log.length ? `${state.log.length} events` : '';
  }
  $('#timeline-toggle').addEventListener('click', () => {
    const open = timeline.dataset.open !== 'true';
    timeline.dataset.open = String(open);
    $('#timeline-toggle').setAttribute('aria-expanded', String(open));
    onLayoutChange?.();
  });

  function renderChoose(state) {
    chooseBlock.hidden = state.status !== 'needs_input';
    if (state.status !== 'needs_input') return;
    $('#choose-text').textContent = state.notice?.text ?? '';
    $('#choose-list').replaceChildren(
      ...state.candidates.map((id) => {
        const entity = demoIndex.entities.get(id);
        const button = textNode('button', 'btn-secondary', `${entity.display} (${KIND_LABEL[entity.kind]})`);
        button.type = 'button';
        button.addEventListener('click', () => controller.open(id));
        return button;
      }),
    );
  }

  function renderRecents() {
    const items = recents?.list() ?? [];
    $('#recents').hidden = items.length === 0;
    $('#recents-list').replaceChildren(
      ...items.map((item) => {
        const button = textNode('button', 'filter-chip', item.input);
        button.type = 'button';
        button.addEventListener('click', () => {
          input.value = item.input;
          controller.open(item.input);
        });
        return button;
      }),
    );
  }

  function refresh() {
    renderFilters();
    const state = controller.state;
    renderFindings(state);
    renderList(state);
    graph.update({
      entityIds: state.entityIds, relationshipIds: state.relationshipIds, selection: state.selection, rootId: state.rootId,
      dimmed: filterActive()
        ? new Set(state.relationshipIds.filter((id) => isDimmed(demoIndex.relationships.get(id))))
        : new Set(),
    });
  }

  function renderLog(state) {
    if (state.log.length === 0) {
      log.replaceChildren(textNode('li', 'empty', 'Nothing yet. Start an investigation to see each step here.'));
      return;
    }
    const start = state.log[0].ts;
    log.replaceChildren(
      ...state.log.map((entry) => {
        const item = document.createElement('li');
        item.className = entry.type === 'investigation.failed' || entry.type === 'agent.blocked' ? 'is-failed' : '';
        item.append(textNode('time', '', timeLabel(entry.ts, start)));
        if (entry.entityId || entry.relationshipId) {
          const button = textNode('button', 'btn-link', entry.summary);
          button.type = 'button';
          button.addEventListener('click', () => (entry.entityId ? controller.selectEntity(entry.entityId) : controller.selectRelationship(entry.relationshipId)));
          item.append(button);
        } else {
          item.append(textNode('span', '', entry.summary));
        }
        return item;
      }),
    );
    log.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  function renderTop(state) {
    runState.textContent = RUN_LABEL[state.run] ?? 'Idle';
    runState.dataset.run = state.run;
    const modeChip = $('#mode-chip');
    modeChip.textContent = state.origin === 'live' ? 'Live' : 'Demo';
    modeChip.className = `chip ${state.origin === 'live' ? 'chip-ok' : 'chip-demo'}`;
    const rootEntity = state.rootId ? demoIndex.entities.get(state.rootId) : null;
    subject.replaceChildren();
    if (rootEntity) {
      subject.append(textNode('span', 'chip', KIND_LABEL[rootEntity.kind]), textNode('strong', '', rootEntity.display));
    } else {
      subject.append(textNode('span', 'subject-none', 'No subject'));
    }
    question.textContent = rootEntity ? `What is connected to ${rootEntity.display}?` : 'No question yet.';
  }

  function renderCenter(state) {
    const hasGraph = state.entityIds.length > 0;
    emptyBlock.hidden = state.status !== 'empty';
    unsupportedBlock.hidden = state.status !== 'unsupported';
    graphBlock.hidden = !hasGraph;
    renderChoose(state);
    $('#ws-toolbar').hidden = !hasGraph;
    if (state.status === 'unsupported') $('#unsupported-text').textContent = state.notice?.text ?? '';
    banner.hidden = !state.banner;
    if (state.banner) {
      banner.className = `banner banner-${state.banner.kind}`;
      banner.textContent = state.banner.text;
    }
  }

  function renderList(state) {
    const entityBody = $('#list-entities');
    const relationBody = $('#list-relationships');
    entityBody.replaceChildren(
      ...state.entityIds.map((id) => {
        const entity = demoIndex.entities.get(id);
        const rowEl = document.createElement('tr');
        const button = textNode('button', 'btn-link', entity.display);
        button.type = 'button';
        button.addEventListener('click', () => controller.selectEntity(id));
        const cell = document.createElement('td');
        cell.append(button);
        rowEl.append(cell, textNode('td', '', KIND_LABEL[entity.kind]));
        return rowEl;
      }),
    );
    relationBody.replaceChildren(
      ...state.relationshipIds.map((id) => {
        const relationship = demoIndex.relationships.get(id);
        const rowEl = document.createElement('tr');
        rowEl.className = isDimmed(relationship) ? 'is-dimmed' : '';
        const button = textNode('button', 'btn-link', relationshipLabel(relationship));
        button.type = 'button';
        button.addEventListener('click', () => controller.selectRelationship(id));
        const cell = document.createElement('td');
        cell.append(button);
        rowEl.append(cell, textNode('td', '', TYPE_LABEL[relationship.type]), textNode('td', '', STATUS_LABEL[relationship.status]));
        return rowEl;
      }),
    );
  }

  function renderInspector(state) {
    const selection = state.selection;
    const key = selection ? `${selection.kind}:${selection.id}` : null;
    if (key !== lastSelectionKey) {
      sheetDismissed = false;
      lastSelectionKey = key;
    }
    if (!selection) {
      renderEmpty(inspector);
      root.dataset.sheet = 'closed';
      return;
    }
    root.dataset.sheet = sheetDismissed ? 'closed' : 'open';
    const handlers = {
      expand: (id) => controller.expand(id),
      focus: () => graph.focusRoot(),
      selectEntity: (id) => controller.selectEntity(id),
    };
    if (selection.kind === 'entity') {
      renderEntity(inspector, {
        index: demoIndex, entityId: selection.id, visibleIds: new Set(state.entityIds),
        canExpand: controller.canExpand(selection.id), handlers,
      });
    } else {
      renderRelationship(inspector, { index: demoIndex, relationshipId: selection.id, handlers });
    }
  }

  function renderAll(state) {
    renderTop(state);
    renderCenter(state);
    renderLog(state);
    renderTimelineBar(state);
    renderRecents();
    refresh();
    const becameReady = state.status === 'ready' && lastStatus !== 'ready';
    if (state.entityIds.length !== lastEntityCount || becameReady) scheduleFit(state);
    lastEntityCount = state.entityIds.length;
    lastStatus = state.status;
    renderInspector(state);
    onLayoutChange?.();
  }
  controller.subscribe(renderAll);

  return { fit: graph.fit, focusInput: () => input.focus(), refreshRecents: renderRecents, render: () => renderAll(controller.state) };
}
