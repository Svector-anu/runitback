import { createDomainEvent } from '../spider/events.js';
import { BINANCE, INTERVAL_MS, MarketError, fetchKlines, fetchTicker, fetchWatchlist } from './binance.js';
import { detectEvents, pickHighlights } from './detect.js';
import { inspectSeries, isClosed, mergeCandles } from './series.js';

const INITIAL_BARS = 500;
const HISTORY_BARS = 500;
const MAX_BARS = 5000;
const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60_000;
const WATCHLIST_MS = 30_000;
const MAX_LOG = 200;

export function createMarket({ bus, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), pollMs = POLL_MS }) {
  const subscribers = new Set();
  let runId = 0;
  let pollTimer = 0;
  let watchTimer = 0;
  let active = false;
  let failures = 0;
  let knownEvents = new Set();
  let polls = 0;

  let state = {
    status: 'idle',
    symbol: null,
    interval: '1h',
    candles: [],
    events: [],
    selection: null,
    selectedEventId: null,
    ticker: null,
    source: null,
    live: 'off',
    liveError: null,
    lastOkAt: null,
    banner: null,
    loadingHistory: false,
    historyExhausted: false,
    gaps: 0,
    watchlist: [],
    watchlistError: null,
    log: [],
    error: null,
  };

  const intervalMs = () => INTERVAL_MS[state.interval];

  function set(patch) {
    state = { ...state, ...patch };
    for (const subscriber of subscribers) subscriber(state);
  }

  function emit(type, summary, payload = {}) {
    const event = createDomainEvent(type, { investigationId: `market:${state.symbol ?? 'none'}:${runId}`, origin: 'live', payload: { summary, symbol: state.symbol, interval: state.interval, ...payload } });
    const entry = { id: event.id, ts: event.ts, type, summary, t: payload.t ?? null, failed: type === 'market.failed' };
    state = { ...state, log: [...state.log, entry].slice(-MAX_LOG) };
    bus.emit(event);
    for (const subscriber of subscribers) subscriber(state);
  }

  function analyze(candles) {
    return detectEvents(candles, INTERVAL_MS[state.interval], now());
  }

  async function open({ symbol, interval = state.interval }) {
    stopPolling();
    const id = ++runId;
    knownEvents = new Set();
    failures = 0;
    set({
      status: 'loading', symbol, interval, candles: [], events: [], selection: null, selectedEventId: null, ticker: null,
      source: null, live: 'off', liveError: null, banner: null, loadingHistory: false, historyExhausted: false, gaps: 0, error: null,
    });
    emit('market.opened', `Opening ${symbol} on ${interval} candles`);

    const [klines, ticker] = await Promise.allSettled([
      fetchKlines({ symbol, interval, limit: INITIAL_BARS, fetchImpl }),
      fetchTicker({ symbol, fetchImpl }),
    ]);
    if (id !== runId) return;

    if (klines.status === 'rejected') {
      fail(klines.reason);
      return;
    }
    const { candles, url, fetchedAt } = klines.value;
    if (candles.length === 0) {
      fail(new MarketError('empty', `The provider has no candles for ${symbol} on ${interval}.`));
      return;
    }
    const report = inspectSeries(candles, INTERVAL_MS[interval]);
    if (!report.ok) {
      fail(new MarketError('inconsistent', `The provider returned inconsistent candles (${report.problems[0]}). Nothing is shown.`));
      return;
    }
    const events = detectEvents(candles, INTERVAL_MS[interval], now());
    knownEvents = new Set(events.map((event) => event.id));
    set({
      status: 'ready', candles, events, gaps: report.gaps, source: { url, fetchedAt, count: candles.length },
      ticker: ticker.status === 'fulfilled' ? ticker.value.ticker : null, live: 'live', lastOkAt: fetchedAt,
      banner: ticker.status === 'rejected' ? { kind: 'warn', text: '24-hour figures are unavailable right now. The chart is unaffected.' } : null,
    });
    emit('market.loaded', `Loaded ${candles.length} ${interval} candles for ${symbol}`, { t: candles[candles.length - 1].t, count: candles.length });
    if (active) schedulePoll();
  }

  function fail(error) {
    const message = error instanceof MarketError ? error.message : 'Something went wrong loading the market.';
    set({ status: 'error', error: { code: error.code ?? 'unknown', message }, live: 'off' });
    emit('market.failed', message, { code: error.code ?? 'unknown' });
  }

  /** Called once the chart has laid out, so the walk covers bars the user can actually see. */
  function investigate({ from, to }) {
    if (state.status !== 'ready') return;
    for (const event of pickHighlights(state.events, { from, to })) {
      emit('market.event_detected', `${event.summary}`, { t: event.t, eventId: event.id, kind: event.kind, auto: true });
    }
  }

  async function pollOnce(id) {
    try {
      const { candles: fresh, fetchedAt } = await fetchKlines({ symbol: state.symbol, interval: state.interval, limit: 3, fetchImpl });
      if (id !== runId) return;
      failures = 0;
      polls += 1;
      const merged = mergeCandles(state.candles, fresh);
      const changed = merged.length !== state.candles.length || fresh.some((candle) => {
        const old = state.candles.find((item) => item.t === candle.t);
        return !old || old.c !== candle.c || old.h !== candle.h || old.l !== candle.l || old.v !== candle.v;
      });
      const patch = { live: 'live', liveError: null, lastOkAt: fetchedAt, banner: state.banner?.kind === 'error' ? null : state.banner };
      if (polls % 3 === 0) refreshTicker(id);
      if (!changed) {
        set(patch);
        return;
      }
      const report = inspectSeries(merged, intervalMs());
      if (!report.ok) throw new MarketError('inconsistent', 'The provider returned inconsistent candles. Live updates are paused.');
      const events = analyze(merged);
      set({ ...patch, candles: merged, events, gaps: report.gaps });
      for (const event of events) {
        if (knownEvents.has(event.id)) continue;
        knownEvents.add(event.id);
        if (event.kind === 'period_high' || event.kind === 'period_low') continue;
        emit('market.event_detected', event.summary, { t: event.t, eventId: event.id, kind: event.kind, auto: false });
      }
    } catch (error) {
      if (id !== runId) return;
      failures += 1;
      const message = error instanceof MarketError ? error.message : 'Live updates failed.';
      set({
        live: 'paused', liveError: { code: error.code ?? 'unknown', message },
        banner: { kind: 'error', text: `Live updates are paused: ${message} The chart shows data from the last successful update.` },
      });
      if (failures === 1) emit('market.failed', message, { code: error.code ?? 'unknown', live: true });
      if (error?.code === 'rate_limited') failures = Math.max(failures, 6);
    }
  }

  async function refreshTicker(id) {
    try {
      const { ticker } = await fetchTicker({ symbol: state.symbol, fetchImpl });
      if (id === runId) set({ ticker });
    } catch {
      // The ticker is secondary; the next successful poll refreshes it.
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!active || state.status !== 'ready') return;
    const id = runId;
    const delay = Math.min(pollMs * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);
    pollTimer = setTimeout(async () => {
      if (document.hidden) {
        schedulePoll();
        return;
      }
      await pollOnce(id);
      if (id === runId) schedulePoll();
    }, failures === 0 ? pollMs : delay);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
  }

  async function refreshWatchlist() {
    try {
      const { tickers } = await fetchWatchlist({ fetchImpl });
      set({ watchlist: tickers, watchlistError: null });
    } catch (error) {
      set({ watchlistError: error instanceof MarketError ? error.message : 'Watchlist unavailable.' });
    }
  }

  function scheduleWatchlist() {
    clearTimeout(watchTimer);
    if (!active) return;
    watchTimer = setTimeout(async () => {
      if (!document.hidden) await refreshWatchlist();
      scheduleWatchlist();
    }, WATCHLIST_MS);
  }

  async function loadMoreHistory() {
    if (state.status !== 'ready' || state.loadingHistory || state.historyExhausted || state.candles.length >= MAX_BARS) return;
    const id = runId;
    set({ loadingHistory: true });
    try {
      const { candles } = await fetchKlines({
        symbol: state.symbol, interval: state.interval, limit: HISTORY_BARS, endTime: state.candles[0].t - 1, fetchImpl,
      });
      if (id !== runId) return;
      if (candles.length === 0) {
        set({ loadingHistory: false, historyExhausted: true });
        return;
      }
      const merged = mergeCandles(state.candles, candles);
      const report = inspectSeries(merged, intervalMs());
      if (!report.ok) throw new MarketError('inconsistent', 'Earlier candles were inconsistent and were not added.');
      const events = analyze(merged);
      for (const event of events) knownEvents.add(event.id);
      set({ candles: merged, events, gaps: report.gaps, loadingHistory: false });
      emit('market.history_loaded', `Loaded ${candles.length} earlier candles`, { count: candles.length });
    } catch (error) {
      if (id !== runId) return;
      set({ loadingHistory: false, banner: { kind: 'warn', text: `Earlier history could not be loaded: ${error.message ?? 'unknown error'}` } });
    }
  }

  function select(t) {
    if (state.status !== 'ready' || !state.candles.some((candle) => candle.t === t)) return;
    set({ selection: { t }, selectedEventId: null });
    emit('market.point_selected', `Selected the bar at ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`, { t, initiator: 'user' });
  }

  function selectEvent(eventId) {
    const event = state.events.find((item) => item.id === eventId);
    if (!event) return;
    set({ selection: { t: event.t }, selectedEventId: eventId });
    emit('market.event_selected', event.summary, { t: event.t, eventId, referenceT: event.reference?.t ?? null, initiator: 'user' });
  }

  function clearSelection() {
    if (!state.selection) return;
    set({ selection: null, selectedEventId: null });
  }

  return {
    get state() { return state; },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    open,
    investigate,
    select,
    selectEvent,
    clearSelection,
    loadMoreHistory,
    refreshWatchlist,
    retry: () => open({ symbol: state.symbol, interval: state.interval }),
    isClosedBar: (candle) => isClosed(candle, intervalMs(), now()),
    setActive(next) {
      if (active === next) return;
      active = next;
      if (active) {
        if (state.watchlist.length === 0) refreshWatchlist();
        scheduleWatchlist();
        if (state.status === 'ready') {
          failures = 0;
          schedulePoll();
        }
      } else {
        stopPolling();
        clearTimeout(watchTimer);
      }
    },
    config: BINANCE,
  };
}
