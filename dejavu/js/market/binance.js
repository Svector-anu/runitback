export const BINANCE = Object.freeze({
  enabled: true,
  base: 'https://data-api.binance.vision/api/v3',
  label: 'Binance Spot public market data',
  intervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
  watchlist: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TONUSDT'],
  timeoutMs: 8000,
});

export const INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
});

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;

export class MarketError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    Object.assign(this, detail);
  }
}

export function isSymbol(value) {
  return SYMBOL_PATTERN.test(value);
}

/** Binance kline row: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...]. */
export function normalizeKline(row) {
  if (!Array.isArray(row) || row.length < 9) throw new MarketError('malformed', 'Unexpected candle format from the provider.');
  const candle = {
    t: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[5]),
    closeTime: Number(row[6]),
    qv: Number(row[7]),
    n: Number(row[8]),
  };
  for (const key of ['t', 'o', 'h', 'l', 'c', 'v', 'closeTime']) {
    if (!Number.isFinite(candle[key])) throw new MarketError('malformed', 'The provider returned a candle with a non-numeric value.');
  }
  return candle;
}

export function normalizeTicker(raw) {
  const ticker = {
    symbol: String(raw.symbol),
    last: Number(raw.lastPrice),
    changePct: Number(raw.priceChangePercent),
    open: Number(raw.openPrice),
    high: Number(raw.highPrice),
    low: Number(raw.lowPrice),
    volume: Number(raw.volume),
    quoteVolume: Number(raw.quoteVolume),
  };
  for (const key of ['last', 'changePct', 'high', 'low', 'volume', 'quoteVolume']) {
    if (!Number.isFinite(ticker[key])) throw new MarketError('malformed', 'The provider returned a ticker with a non-numeric value.');
  }
  return ticker;
}

async function request(path, params, fetchImpl) {
  const query = new URLSearchParams(params);
  const url = `${BINANCE.base}${path}?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BINANCE.timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    throw new MarketError(error?.name === 'AbortError' ? 'timeout' : 'network', 'Could not reach the market data provider.', { url });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (response.status === 429 || response.status === 418) throw new MarketError('rate_limited', 'The provider is rate limiting requests. Updates are paused.', { url, status: response.status });
    if (response.status === 400 && body?.code === -1121) throw new MarketError('invalid_symbol', 'The provider does not list that market.', { url, status: 400 });
    throw new MarketError('http', body?.msg ? `The provider refused the request: ${body.msg}` : `The provider answered HTTP ${response.status}.`, { url, status: response.status });
  }
  try {
    return { json: await response.json(), url };
  } catch {
    throw new MarketError('malformed', 'The provider returned unreadable data.', { url });
  }
}

export async function fetchKlines({ symbol, interval, limit = 500, endTime, startTime, fetchImpl = fetch }) {
  if (!isSymbol(symbol)) throw new MarketError('invalid_symbol', 'That is not a valid market symbol.');
  if (!INTERVAL_MS[interval]) throw new MarketError('invalid_interval', `Unsupported interval ${interval}.`);
  const params = { symbol, interval, limit: String(limit) };
  if (endTime != null) params.endTime = String(endTime);
  if (startTime != null) params.startTime = String(startTime);
  const { json, url } = await request('/klines', params, fetchImpl);
  if (!Array.isArray(json)) throw new MarketError('malformed', 'The provider returned an unexpected response.', { url });
  return { candles: json.map(normalizeKline), url, fetchedAt: Date.now() };
}

export async function fetchTicker({ symbol, fetchImpl = fetch }) {
  if (!isSymbol(symbol)) throw new MarketError('invalid_symbol', 'That is not a valid market symbol.');
  const { json, url } = await request('/ticker/24hr', { symbol }, fetchImpl);
  return { ticker: normalizeTicker(json), url, fetchedAt: Date.now() };
}

export async function fetchWatchlist({ symbols = BINANCE.watchlist, fetchImpl = fetch } = {}) {
  const { json, url } = await request('/ticker/24hr', { symbols: JSON.stringify(symbols) }, fetchImpl);
  if (!Array.isArray(json)) throw new MarketError('malformed', 'The provider returned an unexpected response.', { url });
  return { tickers: json.map(normalizeTicker), url, fetchedAt: Date.now() };
}

/** Link to the provider record behind one candle, so any number on screen can be checked at the source. */
export function candleSourceUrl({ symbol, interval, t }) {
  return `${BINANCE.base}/klines?${new URLSearchParams({ symbol, interval, startTime: String(t), limit: '1' })}`;
}

/** Maps typed input (BTC, eth, sol/usdt, BTCUSDT) to candidate provider symbols, most likely first. */
export function symbolCandidates(raw) {
  const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return [];
  if (cleaned.endsWith('USDT') && cleaned.length > 4) return [cleaned];
  return [`${cleaned}USDT`, cleaned].filter(isSymbol);
}
