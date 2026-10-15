import { BINANCE, INTERVAL_MS, candleSourceUrl } from './binance.js';
import { KIND_LABEL, RULES } from './detect.js';
import { formatPrice, formatUtc } from './chart.js';
import { indexAtTime } from './series.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const chip = (text, className = '') => el('span', `chip ${className}`.trim(), text);

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

function linkRow(label, url, text) {
  const wrapper = el('div', 'ins-row');
  const link = el('a', 'ext-link', text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  wrapper.append(el('dt', '', label), link);
  return wrapper;
}

function list(...rows) {
  const dl = el('dl', 'ins-list');
  dl.append(...rows);
  return dl;
}

const price = (value, decimals = 2) => formatPrice(value, Math.max(decimals, 2));
const number = (value, digits = 4) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const timeOfDay = (ts) => `${new Date(ts).toISOString().slice(11, 19)} UTC`;

function provenance(state, t) {
  const rows = [
    row('Provider', BINANCE.label),
    row('Last refreshed', state.lastOkAt ? timeOfDay(state.lastOkAt) : 'not available'),
  ];
  if (t != null) {
    const url = candleSourceUrl({ symbol: state.symbol, interval: state.interval, t });
    rows.push(linkRow('Raw record', url, 'Open this candle at the provider'));
  } else if (state.source) {
    rows.push(linkRow('Request', state.source.url, 'Open the first request at the provider'));
  }
  return section('Provenance', list(...rows));
}

function summary(state) {
  const { candles } = state;
  const body = el('div');
  const head = el('div', 'ins-head');
  head.append(el('h2', 'ins-title', `${state.symbol} ${state.interval}`), chip('Live data', 'chip-ok'));
  body.append(head);
  body.append(el('p', 'empty', 'Select a bar on the chart, or an event in the list. Everything here comes from the provider\'s candles. Events are computed from those candles by fixed rules and are labeled Derived.'));
  if (candles.length) {
    body.append(
      section('Loaded data', list(
        row('Candles', String(candles.length)),
        row('From', formatUtc(candles[0].t, state.interval !== '1d')),
        row('To', formatUtc(candles[candles.length - 1].t, state.interval !== '1d')),
        row('Missing bars', state.gaps ? `${state.gaps} (the provider has no candle for these periods)` : 'none'),
        row('Earlier history', state.historyExhausted ? 'all loaded' : 'loads as you scroll left'),
      )),
      provenance(state, null),
    );
  }
  return body;
}

function barDetail(state, t, handlers) {
  const { candles } = state;
  const index = indexAtTime(candles, INTERVAL_MS[state.interval], t);
  const bar = candles[index];
  const body = el('div');
  if (!bar) {
    body.append(el('p', 'empty', 'That bar is not loaded.'));
    return body;
  }
  const closed = bar.t + INTERVAL_MS[state.interval] <= Date.now();
  const head = el('div', 'ins-head');
  head.append(el('h2', 'ins-title', formatUtc(bar.t, state.interval !== '1d')), chip(closed ? 'Closed' : 'Forming', closed ? '' : 'chip-warn'), chip('Provider data', 'chip-ok'));
  body.append(head);

  const change = ((bar.c - bar.o) / bar.o) * 100;
  const rangePct = ((bar.h - bar.l) / bar.l) * 100;
  const rows = [
    row('Open', price(bar.o)), row('High', price(bar.h)), row('Low', price(bar.l)), row('Close', price(bar.c)),
    row('Change', `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`), row('Range', `${rangePct.toFixed(2)}%`),
    row('Volume', number(bar.v)), row('Trades', number(bar.n, 0)),
  ];
  if (index >= RULES.volumeLookback) {
    const window = candles.slice(index - RULES.volumeLookback, index);
    const average = window.reduce((sum, candle) => sum + candle.v, 0) / window.length;
    if (average > 0) rows.push(row(`Volume vs ${RULES.volumeLookback}-bar average`, `${(bar.v / average).toFixed(2)}x`));
  }
  body.append(section('Bar', list(...rows)));

  const events = state.events.filter((event) => event.t === bar.t);
  if (events.length) {
    const items = el('ul', 'prov-list');
    for (const event of events) {
      const item = el('li', 'prov-item');
      const button = el('button', 'btn-link', `${KIND_LABEL[event.kind]}: ${event.summary}`);
      button.type = 'button';
      button.addEventListener('click', () => handlers.selectEvent(event.id));
      item.append(button);
      items.append(item);
    }
    body.append(section('Events on this bar', items));
  }
  body.append(provenance(state, bar.t));
  return body;
}

const INPUT_LABEL = {
  volume: 'Volume', average: 'Average volume', ratio: 'Ratio', logReturn: 'Log return', sigma: 'Standard deviation of returns',
  z: 'Standard deviations', previousClose: 'Previous close', close: 'Close', level: 'Level broken', excess: 'Distance beyond level',
  atr: 'Average true range', high: 'High', low: 'Low', bars: 'Bars considered',
};

function eventDetail(state, event, handlers) {
  const body = el('div');
  const head = el('div', 'ins-head');
  head.append(el('h2', 'ins-title', KIND_LABEL[event.kind]), chip('Derived', 'chip-demo'), chip(state.interval));
  body.append(head);
  body.append(el('p', 'ins-lede', event.summary));
  body.append(el('p', 'empty', `Computed by OpenCrawl from the provider's candles at ${formatUtc(event.t, state.interval !== '1d')}. It is not a statement from the provider and not a recommendation.`));

  const inputs = Object.entries(event.inputs).map(([key, value]) => row(INPUT_LABEL[key] ?? key, typeof value === 'number' ? number(value, 6) : String(value)));
  body.append(section('Rule', el('p', 'empty', event.rule)), section('Values used', list(...inputs)));

  if (event.reference) {
    const button = el('button', 'btn-link', `${formatUtc(event.reference.t, state.interval !== '1d')} at ${price(event.reference.price)}`);
    button.type = 'button';
    button.addEventListener('click', () => handlers.revealTime(event.reference.t));
    const wrapper = el('div', 'ins-row');
    wrapper.append(el('dt', '', event.reference.label), button);
    body.append(section('Reference bar', list(wrapper)));
  }
  body.append(provenance(state, event.t));
  return body;
}

export function renderMarketInspector(root, { state, handlers }) {
  let content;
  if (state.status !== 'ready') {
    content = el('p', 'empty', state.status === 'loading' ? 'Loading market data.' : 'No market is open.');
  } else if (state.selectedEventId) {
    const event = state.events.find((item) => item.id === state.selectedEventId);
    content = event ? eventDetail(state, event, handlers) : summary(state);
  } else if (state.selection) {
    content = barDetail(state, state.selection.t, handlers);
  } else {
    content = summary(state);
  }
  root.replaceChildren(content);
}
