import { isClosed } from './series.js';

export const RULES = Object.freeze({
  volumeLookback: 20,
  volumeMultiple: 3,
  moveLookback: 50,
  moveSigma: 3,
  breakoutLookback: 30,
  atrLookback: 14,
});

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function stdev(values) {
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function trueRange(candle, previous) {
  return Math.max(candle.h - candle.l, Math.abs(candle.h - previous.c), Math.abs(candle.l - previous.c));
}

export const KIND_LABEL = Object.freeze({
  volume_spike: 'Volume spike',
  large_move: 'Large move',
  breakout_up: 'Breakout above range',
  breakout_down: 'Breakdown below range',
  period_high: 'Highest price loaded',
  period_low: 'Lowest price loaded',
});

function breakoutAt(candles, i) {
  const { breakoutLookback } = RULES;
  if (i < breakoutLookback) return null;
  const window = candles.slice(i - breakoutLookback, i);
  let highBar = window[0];
  let lowBar = window[0];
  for (const bar of window) {
    if (bar.h > highBar.h) highBar = bar;
    if (bar.l < lowBar.l) lowBar = bar;
  }
  const close = candles[i].c;
  if (close > highBar.h) return { side: 'up', reference: highBar, level: highBar.h };
  if (close < lowBar.l) return { side: 'down', reference: lowBar, level: lowBar.l };
  return null;
}

/**
 * Derived observations computed from provider candles with fixed, documented rules (RULES).
 * Only closed candles are considered, so an event never appears and then vanishes while a bar is forming.
 * Every event carries the numbers it was computed from.
 */
export function detectEvents(candles, intervalMs, now) {
  const events = [];
  const closedCount = candles.filter((candle) => isClosed(candle, intervalMs, now)).length;
  const closed = candles.slice(0, closedCount);
  const { volumeLookback, volumeMultiple, moveLookback, moveSigma, atrLookback } = RULES;

  const returns = closed.map((candle, i) => (i === 0 ? null : Math.log(candle.c / closed[i - 1].c)));
  let previousBreakout = null;

  for (let i = 0; i < closed.length; i++) {
    const bar = closed[i];

    if (i >= volumeLookback) {
      const average = mean(closed.slice(i - volumeLookback, i).map((candle) => candle.v));
      if (average > 0 && bar.v >= volumeMultiple * average) {
        const ratio = bar.v / average;
        events.push({
          id: `volume_spike:${bar.t}`, kind: 'volume_spike', t: bar.t, price: bar.h, side: null,
          strength: ratio / volumeMultiple,
          summary: `Volume ${ratio.toFixed(1)}x the ${volumeLookback}-bar average`,
          rule: `Volume at least ${volumeMultiple}x the average volume of the previous ${volumeLookback} bars.`,
          inputs: { volume: bar.v, average, ratio },
        });
      }
    }

    if (i >= moveLookback) {
      const sample = returns.slice(i - moveLookback, i);
      const sigma = stdev(sample);
      const move = returns[i];
      if (sigma > 0 && Math.abs(move) >= moveSigma * sigma) {
        const z = Math.abs(move) / sigma;
        const up = move > 0;
        events.push({
          id: `large_move:${bar.t}`, kind: 'large_move', t: bar.t, price: up ? bar.h : bar.l, side: up ? 'up' : 'down',
          strength: z / moveSigma,
          summary: `${up ? 'Rose' : 'Fell'} ${(Math.abs(Math.exp(move) - 1) * 100).toFixed(2)}% bar to bar (${z.toFixed(1)} standard deviations)`,
          rule: `Close-to-close log return at least ${moveSigma} standard deviations from zero, measured against the previous ${moveLookback} bars.`,
          inputs: { logReturn: move, sigma, z, previousClose: closed[i - 1].c, close: bar.c },
        });
      }
    }

    const breakout = breakoutAt(closed, i);
    const key = breakout ? breakout.side : null;
    if (breakout && key !== previousBreakout) {
      let rangeSum = 0;
      let rangeCount = 0;
      for (let k = Math.max(1, i - atrLookback); k < i; k++) {
        rangeSum += trueRange(closed[k], closed[k - 1]);
        rangeCount += 1;
      }
      const atr = rangeCount ? rangeSum / rangeCount : 0;
      const excess = Math.abs(bar.c - breakout.level);
      const up = breakout.side === 'up';
      events.push({
        id: `${up ? 'breakout_up' : 'breakout_down'}:${bar.t}`, kind: up ? 'breakout_up' : 'breakout_down', t: bar.t,
        price: up ? bar.h : bar.l, side: breakout.side,
        strength: atr > 0 ? 1 + excess / atr : 1,
        summary: `Closed ${up ? 'above' : 'below'} the ${RULES.breakoutLookback}-bar ${up ? 'high' : 'low'} of ${breakout.level}`,
        rule: `Close beyond the highest high or lowest low of the previous ${RULES.breakoutLookback} bars, on the first bar of a run.`,
        inputs: { close: bar.c, level: breakout.level, excess, atr },
        reference: { t: breakout.reference.t, price: breakout.level, label: `Set the ${RULES.breakoutLookback}-bar ${up ? 'high' : 'low'}` },
      });
    }
    previousBreakout = key;
  }

  if (closed.length >= 2) {
    let highBar = closed[0];
    let lowBar = closed[0];
    for (const bar of closed) {
      if (bar.h > highBar.h) highBar = bar;
      if (bar.l < lowBar.l) lowBar = bar;
    }
    events.push({
      id: `period_high:${highBar.t}`, kind: 'period_high', t: highBar.t, price: highBar.h, side: 'up', strength: 1,
      summary: `Highest price in the ${closed.length} loaded bars: ${highBar.h}`,
      rule: 'Highest high among the closed bars currently loaded. Loading earlier history can change it.',
      inputs: { high: highBar.h, bars: closed.length },
    });
    events.push({
      id: `period_low:${lowBar.t}`, kind: 'period_low', t: lowBar.t, price: lowBar.l, side: 'down', strength: 1,
      summary: `Lowest price in the ${closed.length} loaded bars: ${lowBar.l}`,
      rule: 'Lowest low among the closed bars currently loaded. Loading earlier history can change it.',
      inputs: { low: lowBar.l, bars: closed.length },
    });
  }

  return events.sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind));
}

/** The events worth walking to on open: strongest first, within the visible range, then replayed in time order. */
export function pickHighlights(events, { from, to, limit = 4 }) {
  return events
    .filter((event) => event.t >= from && event.t <= to && event.kind !== 'period_high' && event.kind !== 'period_low')
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit)
    .sort((a, b) => a.t - b.t);
}
