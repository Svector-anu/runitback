import { BINANCE, INTERVAL_MS, symbolCandidates } from './binance.js';
import { isBitcoinAddress } from '../investigation/bitcoin-adapter.js';
import { createChart, formatPrice, formatUtc } from './chart.js';
import { createChartLight } from './chart-light.js';
import { KIND_LABEL } from './detect.js';
import { renderMarketInspector } from './market-inspector.js';

const STORE_KEY = 'opencrawl.market';
const DEFAULT_MARKET = { symbol: 'BTCUSDT', interval: '1h' };
const STALE_AFTER_S = 20;
const TABLE_ROWS = 150;

const $ = (selector, root = document) => root.querySelector(selector);

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function readStored() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY));
    if (value && typeof value.symbol === 'string' && INTERVAL_MS[value.interval]) return value;
  } catch {
    // Falls back to the default market when storage is blocked or unreadable.
  }
  return DEFAULT_MARKET;
}

function writeStored(value) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
  } catch {
    // The choice stays in memory when storage is blocked.
  }
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const baseOf = (symbol) => symbol.replace(/USDT$/, '');
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const timeOfDay = (ts) => new Date(ts).toISOString().slice(11, 19);

export function createMarketView({ market, reducedMotion, onViewChange, onLayoutChange }) {
  const root = $('#terminal');
  const input = $('#query-input');
  const chartHost = $('#chart');
  const marketState = $('#market-state');
  const banner = $('#market-banner');
  const table = $('#market-table');
  const tableToggle = $('#chart-table-toggle');
  const kindFilters = new Set();
  let view = 'market';
  let routeActive = false;
  let started = false;
  let localNotice = null;
  let pendingInvestigate = false;
  let filterVersion = 0;
  let sheetKey = null;
  const pushed = { candles: null, events: null, filters: -1, selection: undefined, reference: undefined, stamp: null, key: null };

  const chart = createChart({
    container: chartHost,
    reducedMotion,
    handlers: {
      onSelectTime: (t) => market.select(t),
      onMarker: (t, eventIds) => (eventIds.length ? market.selectEvent(eventIds[0]) : market.select(t)),
      onNeedHistory: () => market.loadMoreHistory(),
    },
  });
  const light = createChartLight({ chart, reducedMotion });

  function openSymbol(symbol, interval = market.state.interval) {
    writeStored({ symbol, interval });
    return market.open({ symbol, interval });
  }

  async function openFromInput(raw) {
    const candidates = symbolCandidates(raw);
    localNotice = null;
    for (const [index, symbol] of candidates.entries()) {
      await openSymbol(symbol);
      const { status, error } = market.state;
      if (!(status === 'error' && error?.code === 'invalid_symbol' && index < candidates.length - 1)) break;
    }
  }

  const intake = {
    isActive: () => view === 'market',
    detect(raw) {
      const value = raw.trim();
      if (!value) return { label: '' };
      if (isBitcoinAddress(value)) return { label: 'Bitcoin address: opens the Network view' };
      const [first] = symbolCandidates(value);
      return { label: first ? `Market ${first}` : 'Not a market symbol' };
    },
    handleSubmit(raw) {
      if (isBitcoinAddress(raw)) {
        setView('network');
        return false;
      }
      if (symbolCandidates(raw).length === 0) {
        localNotice = { kind: 'warn', text: 'Enter a market symbol such as BTC, ETH or SOL. A Bitcoin address opens the Network view.' };
        renderBanner(market.state);
        return true;
      }
      openFromInput(raw);
      return true;
    },
  };

  function setView(next) {
    if (next === view) return;
    view = next;
    root.dataset.view = next;
    for (const button of root.querySelectorAll('[data-view-tab]')) button.setAttribute('aria-pressed', String(button.dataset.viewTab === next));
    root.querySelector('[data-pane-tab="graph"]').textContent = next === 'market' ? 'Chart' : 'Graph';
    input.placeholder = next === 'market' ? 'Symbol like BTC or ETH' : 'Bitcoin address, or type demo';
    input.value = '';
    $('#detected-chip').hidden = true;
    syncActive();
    if (next === 'market') render(market.state);
    onViewChange?.(next);
    onLayoutChange?.();
  }

  function syncActive() {
    const active = routeActive && view === 'market';
    market.setActive(active);
    if (active && !started) {
      started = true;
      const stored = readStored();
      openSymbol(stored.symbol, stored.interval);
    }
  }

  function renderHead(state) {
    $('#mh-symbol').textContent = state.symbol ? `${baseOf(state.symbol)} / USDT` : 'Market';
    const last = state.candles[state.candles.length - 1];
    $('#mh-last').textContent = last ? formatPrice(last.c, Math.max(chart.decimals, 2)) : '-';
    const change = $('#mh-change');
    if (state.ticker) {
      change.textContent = `${signed(state.ticker.changePct)} 24h`;
      change.className = `mh-change ${state.ticker.changePct >= 0 ? 'is-up' : 'is-down'}`;
    } else {
      change.textContent = '';
    }
    const stats = $('#mh-stats');
    if (state.ticker) {
      const decimals = Math.max(chart.decimals, 2);
      const entries = [['24h high', formatPrice(state.ticker.high, decimals)], ['24h low', formatPrice(state.ticker.low, decimals)], ['24h volume', `${compact.format(state.ticker.quoteVolume)} USDT`]];
      stats.replaceChildren(...entries.flatMap(([label, value]) => {
        const wrapper = document.createElement('div');
        wrapper.append(textNode('dt', '', label), textNode('dd', '', value));
        return [wrapper];
      }));
    } else {
      stats.replaceChildren();
    }
  }

  function renderLiveChip(state) {
    const chip = $('#mh-live');
    let text = 'Not loaded';
    let tone = 'chip-quiet';
    if (state.status === 'loading') text = 'Loading';
    else if (state.status === 'error') { text = 'Unavailable'; tone = 'chip-warn'; }
    else if (state.status === 'ready' && state.lastOkAt) {
      const age = Math.max(0, Math.round((Date.now() - state.lastOkAt) / 1000));
      if (state.live === 'paused') { text = `Paused, last update ${age}s ago`; tone = 'chip-warn'; }
      else if (age > STALE_AFTER_S) { text = `Stale, ${age}s old`; tone = 'chip-warn'; }
      else { text = `Live, updated ${age}s ago`; tone = 'chip-ok'; }
    }
    chip.textContent = text;
    chip.className = `chip ${tone}`;
    const modeChip = $('#mode-chip');
    modeChip.textContent = state.status === 'ready' ? 'Live' : 'Market';
    modeChip.className = `chip ${state.status === 'ready' ? 'chip-ok' : 'chip-quiet'}`;
  }

  function renderTop(state) {
    const run = $('#run-state');
    const labels = { idle: 'Idle', loading: 'Loading', ready: state.live === 'paused' ? 'Paused' : 'Watching', error: 'Error' };
    run.textContent = labels[state.status] ?? 'Idle';
    run.dataset.run = { idle: 'idle', loading: 'resolving', ready: 'tracing', error: 'needs_input' }[state.status] ?? 'idle';
    const subject = $('#ws-subject');
    subject.replaceChildren(...(state.symbol ? [textNode('span', 'chip', 'Market'), textNode('strong', '', state.symbol)] : [textNode('span', 'subject-none', 'No market')]));
  }

  function renderToolbar(state) {
    const seg = $('#interval-seg');
    if (seg.children.length === 0) {
      for (const interval of BINANCE.intervals) {
        const button = textNode('button', '', interval);
        button.type = 'button';
        button.dataset.interval = interval;
        button.addEventListener('click', () => {
          if (market.state.symbol && interval !== market.state.interval) openSymbol(market.state.symbol, interval);
        });
        seg.append(button);
      }
    }
    for (const button of seg.children) button.setAttribute('aria-pressed', String(button.dataset.interval === state.interval));
    for (const button of root.querySelectorAll('[data-chart-type]')) button.setAttribute('aria-pressed', String(button.dataset.chartType === chart.type));
    const status = $('#market-status');
    status.textContent = state.loadingHistory ? 'Loading earlier candles' : '';
  }

  function renderBanner(state) {
    const notice = localNotice ?? state.banner;
    banner.hidden = !notice;
    if (notice) {
      banner.className = `banner banner-${notice.kind}`;
      banner.textContent = notice.text;
    }
  }

  function renderState(state) {
    const show = state.status !== 'ready';
    marketState.hidden = !show;
    chartHost.classList.toggle('is-covered', show);
    if (!show) return;
    marketState.replaceChildren();
    if (state.status === 'loading') {
      marketState.append(textNode('h2', '', `Loading ${state.symbol}`), textNode('p', '', `Reading ${state.interval} candles from ${BINANCE.label}.`));
    } else if (state.status === 'error') {
      const retry = textNode('button', 'btn-primary', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', () => market.retry());
      marketState.append(textNode('h2', '', 'Could not load this market'), textNode('p', '', state.error?.message ?? 'Unknown error.'), retry);
    } else {
      marketState.append(textNode('h2', '', 'Start with a market'), textNode('p', '', 'Type a symbol such as BTC, ETH or SOL, or pick one from the list.'));
    }
  }

  function renderWatchlist(state) {
    const list = $('#watchlist');
    if (state.watchlist.length === 0) {
      list.replaceChildren(textNode('li', 'empty', state.watchlistError ?? 'Loading prices'));
      return;
    }
    list.replaceChildren(...state.watchlist.map((ticker) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'watch-row';
      button.setAttribute('aria-pressed', String(ticker.symbol === state.symbol));
      button.append(
        textNode('span', 'watch-symbol', baseOf(ticker.symbol)),
        textNode('span', 'watch-price', formatPrice(ticker.last, ticker.last < 1 ? 4 : 2)),
        textNode('span', `watch-change ${ticker.changePct >= 0 ? 'is-up' : 'is-down'}`, signed(ticker.changePct)),
      );
      button.addEventListener('click', () => {
        localNotice = null;
        openSymbol(ticker.symbol);
      });
      item.append(button);
      return item;
    }));
  }

  const filteredEvents = (events) => (kindFilters.size ? events.filter((event) => kindFilters.has(event.kind)) : events);

  function renderFilters(state) {
    const kinds = [...new Set(state.events.map((event) => event.kind))];
    $('#mfilter-kinds').replaceChildren(...kinds.map((kind) => {
      const button = textNode('button', 'filter-chip', KIND_LABEL[kind]);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(kindFilters.has(kind)));
      button.addEventListener('click', () => {
        if (kindFilters.has(kind)) kindFilters.delete(kind);
        else kindFilters.add(kind);
        filterVersion += 1;
        render(market.state);
      });
      return button;
    }));
    $('#mfilter-count').hidden = kindFilters.size === 0;
    $('#mfilter-count').textContent = String(kindFilters.size);
    $('#mfilters-clear').hidden = kindFilters.size === 0;
  }
  $('#mfilters-clear').addEventListener('click', () => {
    kindFilters.clear();
    filterVersion += 1;
    render(market.state);
  });

  function renderFindings(state) {
    const list = $('#mfindings');
    const events = filteredEvents(state.events);
    if (events.length === 0) {
      list.replaceChildren(textNode('li', 'empty', state.status === 'ready' ? 'No events match. Events are computed from the loaded candles by fixed rules.' : 'Events appear here once candles are loaded.'));
      return;
    }
    list.replaceChildren(...[...events].reverse().slice(0, 80).map((event) => {
      const item = document.createElement('li');
      if (event.id === state.selectedEventId) item.className = 'is-active';
      const button = textNode('button', 'btn-link', `${KIND_LABEL[event.kind]}, ${formatUtc(event.t, state.interval !== '1d').replace(' UTC', '')}`);
      button.type = 'button';
      button.addEventListener('click', () => {
        chart.revealRange(event.t, event.reference?.t);
        market.selectEvent(event.id);
      });
      const meta = document.createElement('span');
      meta.className = 'finding-meta';
      meta.append(textNode('span', 'chip chip-demo', 'Derived'), textNode('span', 'finding-text', event.summary));
      item.append(button, meta);
      return item;
    }));
  }

  function renderLog(state) {
    const log = $('#log');
    $('#timeline-latest').textContent = state.log.length ? state.log[state.log.length - 1].summary : 'No events yet.';
    $('#timeline-count').textContent = state.log.length ? `${state.log.length} events` : '';
    if (state.log.length === 0) {
      log.replaceChildren(textNode('li', 'empty', 'Market events appear here as they happen.'));
      return;
    }
    log.replaceChildren(...state.log.map((entry) => {
      const item = document.createElement('li');
      item.className = entry.failed ? 'is-failed' : '';
      item.append(textNode('time', '', timeOfDay(entry.ts).slice(0, 8)));
      if (entry.t != null && state.candles.some((candle) => candle.t === entry.t)) {
        const button = textNode('button', 'btn-link', entry.summary);
        button.type = 'button';
        button.addEventListener('click', () => {
          chart.revealTime(entry.t);
          market.select(entry.t);
        });
        item.append(button);
      } else {
        item.append(textNode('span', '', entry.summary));
      }
      return item;
    }));
    log.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }

  function renderTable(state) {
    if (table.hidden) return;
    const body = $('#market-table-body');
    const rows = [...state.candles].reverse().slice(0, TABLE_ROWS);
    const decimals = Math.max(chart.decimals, 2);
    body.replaceChildren(...rows.map((candle) => {
      const tr = document.createElement('tr');
      const timeCell = document.createElement('td');
      const button = textNode('button', 'btn-link', formatUtc(candle.t, state.interval !== '1d'));
      button.type = 'button';
      button.addEventListener('click', () => market.select(candle.t));
      timeCell.append(button);
      tr.append(timeCell, ...[candle.o, candle.h, candle.l, candle.c].map((value) => textNode('td', '', formatPrice(value, decimals))), textNode('td', '', compact.format(candle.v)));
      return tr;
    }));
  }

  const inspectorHandlers = {
    selectEvent: (id) => market.selectEvent(id),
    revealTime: (t) => chart.revealTime(t),
  };

  function syncChart(state) {
    const dataChanged = state.candles !== pushed.candles;
    if (dataChanged) {
      const key = `${state.symbol}|${state.interval}|${state.source?.fetchedAt ?? ''}`;
      const reset = key !== pushed.key;
      chart.setData({ candles: state.candles, intervalMs: INTERVAL_MS[state.interval], resetView: reset });
      pushed.candles = state.candles;
      pushed.key = key;
      if (reset && state.status === 'ready') pendingInvestigate = true;
    }
    if (dataChanged || state.events !== pushed.events || filterVersion !== pushed.filters) {
      chart.setEvents(filteredEvents(state.events));
      pushed.events = state.events;
      pushed.filters = filterVersion;
    }
    const selected = state.selection?.t ?? null;
    const event = state.selectedEventId ? state.events.find((item) => item.id === state.selectedEventId) : null;
    const reference = event?.reference ?? null;
    const selectionChanged = selected !== pushed.selection || reference !== pushed.reference;
    if (selected !== pushed.selection) {
      pushed.selection = selected;
      chart.setSelection(selected);
    }
    if (reference !== pushed.reference) {
      pushed.reference = reference;
      chart.setReference(reference);
    }
    if (selectionChanged && selected != null) chart.revealRange(selected, reference?.t);
    chart.flush();
    if (pendingInvestigate && state.status === 'ready') {
      pendingInvestigate = false;
      requestAnimationFrame(() => requestAnimationFrame(() => market.investigate(chart.getView())));
    }
  }

  function render(state) {
    if (view !== 'market') return;
    syncChart(state);
    renderHead(state);
    renderLiveChip(state);
    renderTop(state);
    renderToolbar(state);
    renderBanner(state);
    renderState(state);
    renderWatchlist(state);
    renderFilters(state);
    renderFindings(state);
    renderLog(state);
    renderTable(state);
    renderMarketInspector($('#inspector-body'), { state, handlers: inspectorHandlers });
    const key = state.selection ? `${state.selection.t}:${state.selectedEventId ?? ''}` : null;
    if (key !== sheetKey) {
      sheetKey = key;
      root.dataset.sheet = key ? 'open' : 'closed';
    }
    $('#ws-question').textContent = '';
    onLayoutChange?.();
  }

  market.subscribe(render);

  for (const button of root.querySelectorAll('[data-view-tab]')) button.addEventListener('click', () => setView(button.dataset.viewTab));
  for (const button of root.querySelectorAll('[data-chart-type]')) {
    button.addEventListener('click', () => {
      chart.setType(button.dataset.chartType);
      renderToolbar(market.state);
    });
  }
  $('#chart-zoom-in').addEventListener('click', () => chart.zoom(1.3));
  $('#chart-zoom-out').addEventListener('click', () => chart.zoom(0.77));
  $('#chart-fit').addEventListener('click', () => chart.fit());
  $('#chart-latest').addEventListener('click', () => chart.latest());
  tableToggle.addEventListener('click', () => {
    const open = table.hidden;
    table.hidden = !open;
    chartHost.hidden = open;
    tableToggle.setAttribute('aria-pressed', String(open));
    tableToggle.textContent = open ? 'Chart' : 'Table';
    if (open) renderTable(market.state);
    else chart.resize();
  });

  document.addEventListener('keydown', (event) => {
    if (root.hidden || view !== 'market') return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (event.key === 'Escape') {
      market.clearSelection();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'f') chart.fit();
    else if (event.key === 'l') chart.latest();
    else if (event.key === 'm') setView('network');
  });

  setInterval(() => {
    if (routeActive && view === 'market' && !document.hidden) renderLiveChip(market.state);
  }, 1000);

  return {
    intake,
    chart,
    light,
    get view() { return view; },
    setView,
    setRouteActive(active) {
      routeActive = active;
      syncActive();
    },
    openSymbol,
  };
}
