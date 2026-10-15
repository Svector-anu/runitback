import assert from 'node:assert/strict';
import {
  INTERVAL_MS, MarketError, candleSourceUrl, fetchKlines, fetchTicker, isSymbol, normalizeKline, symbolCandidates,
} from '../js/market/binance.js';
import { inspectSeries, indexAtTime, lowerBound, mergeCandles } from '../js/market/series.js';
import { RULES, detectEvents, pickHighlights } from '../js/market/detect.js';
import { createMarket } from '../js/market/market.js';
import { createEventBus, DOMAIN_EVENT_TYPES } from '../js/spider/events.js';

const HOUR = INTERVAL_MS['1h'];
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const row = (t, o, h, l, c, v) => [t, String(o), String(h), String(l), String(c), String(v), t + HOUR - 1, String(v * c), 10, '0', '0', '0'];
const bar = (t, o, h, l, c, v) => ({ t, o, h, l, c, v });

function flatSeries(count, { price = 100, volume = 10 } = {}) {
  return Array.from({ length: count }, (_, i) => bar(i * HOUR, price, price + 1, price - 1, price, volume));
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const failResponse = (status, body) => ({ ok: false, status, json: async () => body });

check('normalizeKline reads Binance rows and rejects bad numbers', () => {
  const candle = normalizeKline(row(0, 1, 2, 0.5, 1.5, 7));
  assert.deepEqual([candle.t, candle.o, candle.h, candle.l, candle.c, candle.v], [0, 1, 2, 0.5, 1.5, 7]);
  assert.throws(() => normalizeKline([0, 'x', '1', '1', '1', '1', 1, '1', 1]), (error) => error.code === 'malformed');
  assert.throws(() => normalizeKline('nope'), MarketError);
});

check('symbols are validated and mapped from loose input', () => {
  assert.equal(isSymbol('BTCUSDT'), true);
  assert.equal(isSymbol('btc usdt&x=1'), false);
  assert.deepEqual(symbolCandidates('eth'), ['ETHUSDT']);
  assert.deepEqual(symbolCandidates('sol/usdt'), ['SOLUSDT']);
  assert.deepEqual(symbolCandidates('BTCUSDT'), ['BTCUSDT']);
  assert.deepEqual(symbolCandidates('  '), []);
});

check('fetchKlines builds the expected request and normalizes candles', async () => {
  let seen;
  const fetchImpl = async (url) => {
    seen = url;
    return okResponse([row(0, 1, 2, 1, 2, 5), row(HOUR, 2, 3, 2, 3, 6)]);
  };
  const result = await fetchKlines({ symbol: 'BTCUSDT', interval: '1h', limit: 2, fetchImpl });
  assert.match(seen, /\/klines\?symbol=BTCUSDT&interval=1h&limit=2$/);
  assert.equal(result.candles.length, 2);
  assert.equal(result.candles[1].c, 3);
});

check('provider failures become typed errors, never empty data', async () => {
  const cases = [
    [async () => { throw new TypeError('offline'); }, 'network'],
    [async () => failResponse(429, null), 'rate_limited'],
    [async () => failResponse(400, { code: -1121, msg: 'Invalid symbol.' }), 'invalid_symbol'],
    [async () => failResponse(500, { msg: 'boom' }), 'http'],
    [async () => okResponse({ not: 'an array' }), 'malformed'],
  ];
  for (const [fetchImpl, code] of cases) {
    await assert.rejects(fetchKlines({ symbol: 'BTCUSDT', interval: '1h', fetchImpl }), (error) => error.code === code);
  }
  await assert.rejects(fetchKlines({ symbol: 'bad symbol', interval: '1h', fetchImpl: async () => okResponse([]) }), (error) => error.code === 'invalid_symbol');
  await assert.rejects(fetchKlines({ symbol: 'BTCUSDT', interval: '7m', fetchImpl: async () => okResponse([]) }), (error) => error.code === 'invalid_interval');
});

check('fetchTicker normalizes the 24h ticker', async () => {
  const fetchImpl = async () => okResponse({
    symbol: 'BTCUSDT', lastPrice: '81086.73', priceChangePercent: '-2.854', openPrice: '83000', highPrice: '84000', lowPrice: '80000', volume: '1000', quoteVolume: '81000000',
  });
  const { ticker } = await fetchTicker({ symbol: 'BTCUSDT', fetchImpl });
  assert.equal(ticker.last, 81086.73);
  assert.equal(ticker.changePct, -2.854);
});

check('source link points at exactly one candle', () => {
  const url = candleSourceUrl({ symbol: 'BTCUSDT', interval: '1h', t: 1792054800000 });
  assert.match(url, /symbol=BTCUSDT/);
  assert.match(url, /startTime=1792054800000/);
  assert.match(url, /limit=1/);
});

check('mergeCandles replaces the forming bar and stays ordered', () => {
  const base = [bar(0, 1, 2, 1, 2, 1), bar(HOUR, 2, 3, 2, 3, 1)];
  const merged = mergeCandles(base, [bar(HOUR, 2, 4, 2, 4, 9), bar(2 * HOUR, 4, 5, 4, 5, 1)]);
  assert.deepEqual(merged.map((candle) => candle.t), [0, HOUR, 2 * HOUR]);
  assert.equal(merged[1].h, 4);
  assert.equal(base[1].h, 3, 'input is not mutated');
});

check('inspectSeries flags impossible candles and counts real gaps', () => {
  assert.equal(inspectSeries(flatSeries(5), HOUR).ok, true);
  const broken = [bar(0, 10, 9, 8, 9, 1)];
  assert.equal(inspectSeries(broken, HOUR).ok, false);
  const gappy = [bar(0, 1, 2, 1, 2, 1), bar(3 * HOUR, 2, 3, 2, 3, 1)];
  const report = inspectSeries(gappy, HOUR);
  assert.equal(report.ok, true);
  assert.equal(report.gaps, 2);
  assert.equal(inspectSeries([bar(HOUR, 1, 2, 1, 2, 1), bar(0, 1, 2, 1, 2, 1)], HOUR).ok, false);
});

check('time lookups find the right candle', () => {
  const series = flatSeries(4);
  assert.equal(indexAtTime(series, HOUR, HOUR + 5), 1);
  assert.equal(indexAtTime(series, HOUR, 10 * HOUR), -1);
  assert.equal(lowerBound(series, HOUR), 1);
  assert.equal(lowerBound(series, 99 * HOUR), 4);
});

check('a quiet series produces no volume, move, or breakout events', () => {
  const series = flatSeries(120);
  const events = detectEvents(series, HOUR, 200 * HOUR).filter((event) => !event.kind.startsWith('period_'));
  assert.equal(events.length, 0);
});

check('a volume spike is detected with its inputs', () => {
  const series = flatSeries(60);
  series[50] = bar(50 * HOUR, 100, 101, 99, 100, 10 * RULES.volumeMultiple + 1);
  const events = detectEvents(series, HOUR, 200 * HOUR).filter((event) => event.kind === 'volume_spike');
  assert.equal(events.length, 1);
  assert.equal(events[0].t, 50 * HOUR);
  assert.equal(events[0].inputs.average, 10);
  assert.ok(events[0].strength > 1);
});

check('a large move is detected only against real volatility', () => {
  const series = Array.from({ length: 80 }, (_, i) => {
    const price = 100 + (i % 2 === 0 ? 0.1 : -0.1);
    return bar(i * HOUR, price, price + 0.2, price - 0.2, price, 10);
  });
  series[70] = bar(70 * HOUR, 100, 106, 99.9, 105, 10);
  const moves = detectEvents(series, HOUR, 500 * HOUR).filter((event) => event.kind === 'large_move');
  assert.ok(moves.some((event) => event.t === 70 * HOUR && event.side === 'up'));
  assert.ok(moves.every((event) => event.inputs.z >= RULES.moveSigma));
});

check('a breakout fires once per run and references the bar that set the level', () => {
  const series = flatSeries(60);
  series[20] = bar(20 * HOUR, 100, 103, 99, 100, 10);
  series[45] = bar(45 * HOUR, 100, 106, 100, 105, 10);
  series[46] = bar(46 * HOUR, 105, 107, 104, 106, 10);
  const breakouts = detectEvents(series, HOUR, 500 * HOUR).filter((event) => event.kind === 'breakout_up');
  assert.equal(breakouts.length, 1);
  assert.equal(breakouts[0].t, 45 * HOUR);
  assert.equal(breakouts[0].reference.t, 20 * HOUR);
  assert.equal(breakouts[0].reference.price, 103);
});

check('the forming candle never produces an event', () => {
  const series = flatSeries(60);
  series[59] = bar(59 * HOUR, 100, 140, 100, 139, 10_000);
  const now = 59 * HOUR + 1000;
  const events = detectEvents(series, HOUR, now);
  assert.ok(events.every((event) => event.t < 59 * HOUR));
});

check('period high and low come from loaded closed bars', () => {
  const series = flatSeries(30);
  series[7] = bar(7 * HOUR, 100, 130, 99, 100, 10);
  series[20] = bar(20 * HOUR, 100, 101, 70, 100, 10);
  const events = detectEvents(series, HOUR, 100 * HOUR);
  assert.equal(events.find((event) => event.kind === 'period_high').price, 130);
  assert.equal(events.find((event) => event.kind === 'period_low').price, 70);
});

check('highlights are the strongest visible events, replayed in time order', () => {
  const events = [
    { t: 1, kind: 'volume_spike', strength: 1.2 }, { t: 2, kind: 'large_move', strength: 3 },
    { t: 3, kind: 'volume_spike', strength: 2 }, { t: 4, kind: 'period_high', strength: 99 },
    { t: 99, kind: 'large_move', strength: 50 },
  ];
  const picked = pickHighlights(events, { from: 0, to: 10, limit: 2 });
  assert.deepEqual(picked.map((event) => event.t), [2, 3]);
});

function stubProvider({ failKlines = null, rows = null } = {}) {
  const calls = [];
  const series = rows ?? Array.from({ length: 80 }, (_, i) => row(i * HOUR, 100, 101, 99, 100, i === 70 ? 100 : 10));
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/klines')) {
      if (failKlines) return failKlines;
      return okResponse(series);
    }
    return okResponse({ symbol: 'BTCUSDT', lastPrice: '100', priceChangePercent: '1.5', openPrice: '99', highPrice: '101', lowPrice: '98', volume: '10', quoteVolume: '1000' });
  };
  return { fetchImpl, calls };
}

function newMarket(options) {
  const bus = createEventBus(DOMAIN_EVENT_TYPES);
  const seen = [];
  bus.on('*', (event) => seen.push(event));
  const { fetchImpl, calls } = stubProvider(options);
  const market = createMarket({ bus, fetchImpl, now: () => 200 * HOUR });
  return { market, seen, calls };
}

check('opening a market loads real candles, detects events and announces them', async () => {
  const { market, seen } = newMarket();
  await market.open({ symbol: 'BTCUSDT', interval: '1h' });
  assert.equal(market.state.status, 'ready');
  assert.equal(market.state.candles.length, 80);
  assert.equal(market.state.ticker.changePct, 1.5);
  assert.ok(market.state.events.some((event) => event.kind === 'volume_spike' && event.t === 70 * HOUR));
  assert.deepEqual(seen.map((event) => event.type).slice(0, 2), ['market.opened', 'market.loaded']);
  assert.ok(seen.every((event) => event.origin === 'live'));
});

check('investigate walks only to strong events inside the visible range', async () => {
  const { market, seen } = newMarket();
  await market.open({ symbol: 'BTCUSDT', interval: '1h' });
  market.investigate({ from: 60 * HOUR, to: 79 * HOUR });
  const found = seen.filter((event) => event.type === 'market.event_detected');
  assert.ok(found.length >= 1);
  assert.ok(found.every((event) => event.payload.t >= 60 * HOUR && event.payload.t <= 79 * HOUR && event.payload.auto));
  const before = seen.length;
  market.investigate({ from: 0, to: 1 });
  assert.equal(seen.length, before, 'nothing in an empty range');
});

check('selection only accepts bars that exist', async () => {
  const { market, seen } = newMarket();
  await market.open({ symbol: 'BTCUSDT', interval: '1h' });
  market.select(12345);
  assert.equal(market.state.selection, null);
  market.select(10 * HOUR);
  assert.equal(market.state.selection.t, 10 * HOUR);
  market.selectEvent('volume_spike:' + 70 * HOUR);
  assert.equal(market.state.selection.t, 70 * HOUR);
  assert.equal(seen.at(-1).type, 'market.event_selected');
  market.clearSelection();
  assert.equal(market.state.selection, null);
});

check('a provider failure shows an error and never fabricates candles', async () => {
  const { market, seen } = newMarket({ failKlines: failResponse(500, { msg: 'down' }) });
  await market.open({ symbol: 'BTCUSDT', interval: '1h' });
  assert.equal(market.state.status, 'error');
  assert.equal(market.state.candles.length, 0);
  assert.equal(seen.at(-1).type, 'market.failed');
});

check('an unknown symbol reports invalid_symbol', async () => {
  const { market } = newMarket({ failKlines: failResponse(400, { code: -1121, msg: 'Invalid symbol.' }) });
  await market.open({ symbol: 'NOPEUSDT', interval: '1h' });
  assert.equal(market.state.error.code, 'invalid_symbol');
});

check('inconsistent candles are refused instead of drawn', async () => {
  const bad = [row(0, 100, 90, 95, 100, 1), row(HOUR, 100, 101, 99, 100, 1)];
  const { market } = newMarket({ rows: bad });
  await market.open({ symbol: 'BTCUSDT', interval: '1h' });
  assert.equal(market.state.status, 'error');
  assert.equal(market.state.error.code, 'inconsistent');
});

check('a newer open supersedes a slow earlier one', async () => {
  const bus = createEventBus(DOMAIN_EVENT_TYPES);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url) => {
    if (url.includes('symbol=ETHUSDT') && url.includes('/klines')) await gate;
    if (url.includes('/klines')) return okResponse([row(0, 1, 2, 1, 2, 1), row(HOUR, 2, 3, 2, 3, 1)]);
    return okResponse({ symbol: 'X', lastPrice: '1', priceChangePercent: '0', openPrice: '1', highPrice: '1', lowPrice: '1', volume: '1', quoteVolume: '1' });
  };
  const market = createMarket({ bus, fetchImpl, now: () => 200 * HOUR });
  const slow = market.open({ symbol: 'ETHUSDT', interval: '1h' });
  await market.open({ symbol: 'BTCUSDT', interval: '1h' });
  release();
  await slow;
  assert.equal(market.state.symbol, 'BTCUSDT');
  assert.equal(market.state.status, 'ready');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n${error.stack}`);
  }
}
console.log(failed ? `${failed} of ${checks.length} failed` : `${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
