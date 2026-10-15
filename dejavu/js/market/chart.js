import { indexAtTime, lowerBound } from './series.js';

const AXIS_W = 72;
const PAD_L = 6;
const PAD_TOP = 10;
const TIME_H = 26;
const MIN_BAR_PX = 2;
const MAX_BAR_PX = 48;
const FUTURE_SHARE = 0.4;
const HISTORY_MARGIN_BARS = 40;
const MARKER_SIZE = 14;
const SPIDER_STAND_OFF = 46;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TIME_STEPS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 30 * DAY];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pad2 = (value) => String(value).padStart(2, '0');

export function markerId(t) {
  return `mk:${t}`;
}

export function formatUtc(t, withTime = true) {
  const d = new Date(t);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  return withTime ? `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC` : date;
}

export function niceStep(range, targetCount) {
  const raw = range / targetCount;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const factor = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return factor * power;
}

export function formatPrice(value, decimals) {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function decimalsFor(step) {
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

function formatVolume(value) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(value < 10 ? 4 : 2);
}

function tickLabel(t, step) {
  const d = new Date(t);
  if (step >= DAY) return d.getUTCDate() === 1 ? MONTHS[d.getUTCMonth()] : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function createChart({ container, reducedMotion, handlers }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  const markersLayer = document.createElement('div');
  markersLayer.className = 'chart-markers';
  const readout = document.createElement('div');
  readout.className = 'chart-readout';
  const announce = document.createElement('div');
  announce.className = 'visually-hidden';
  announce.setAttribute('aria-live', 'polite');
  container.append(canvas, markersLayer, readout, announce);
  container.tabIndex = 0;
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Price chart. Arrow keys move between bars, plus and minus zoom, Home and End jump.');
  const ctx = canvas.getContext('2d');

  const style = getComputedStyle(container);
  const css = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const colors = {
    up: css('--up', '#5fd3b0'),
    down: css('--down', '#ff6f91'),
    grid: css('--grid', 'rgba(255,255,255,0.06)'),
    text: css('--axis-text', '#9a93a8'),
    line: css('--line', '#e9d5ff'),
    accent: css('--accent', '#e070b0'),
    violet: css('--violet', '#8a6bd8'),
  };

  let candles = [];
  let intervalMs = HOUR;
  let tLeft = 0;
  let barPx = 9;
  let type = 'candles';
  let width = 0;
  let height = 0;
  let dpr = 1;
  let yMin = 0;
  let yMax = 1;
  let yTarget = null;
  let hover = null;
  let selectionT = null;
  let reference = null;
  let events = [];
  let lastT = null;
  let dirty = false;
  let raf = 0;
  let lastHistoryAsk = 0;
  let decimals = 2;
  let fitted = false;
  const markerNodes = new Map();
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  const plot = () => {
    const left = PAD_L;
    const right = Math.max(left + 40, width - AXIS_W);
    const top = PAD_TOP;
    const bottom = Math.max(top + 80, height - TIME_H);
    const volumeH = Math.round((bottom - top) * 0.16);
    return { left, right, top, bottom, priceBottom: bottom - volumeH - 6, volumeTop: bottom - volumeH, width: right - left };
  };

  const spanT = () => (plot().width * intervalMs) / barPx;
  const xLeftEdge = (t) => plot().left + ((t - tLeft) * barPx) / intervalMs;
  const xCenter = (t) => xLeftEdge(t) + barPx / 2;
  const timeAt = (x) => tLeft + ((x - plot().left) * intervalMs) / barPx;
  const yOf = (price) => {
    const p = plot();
    return p.top + ((yMax - price) / (yMax - yMin)) * (p.priceBottom - p.top);
  };
  const priceAt = (y) => {
    const p = plot();
    return yMax - ((y - p.top) / (p.priceBottom - p.top)) * (yMax - yMin);
  };

  function visibleRange() {
    const from = Math.max(0, lowerBound(candles, tLeft - intervalMs));
    const to = Math.min(candles.length, lowerBound(candles, tLeft + spanT()) + 1);
    return { from, to };
  }

  function clampView() {
    if (candles.length === 0) return;
    const span = spanT();
    const firstT = candles[0].t;
    const maxLeft = candles[candles.length - 1].t + intervalMs - span * (1 - FUTURE_SHARE);
    const minLeft = firstT - span * FUTURE_SHARE;
    tLeft = clamp(tLeft, Math.min(minLeft, maxLeft), maxLeft);
  }

  function retarget() {
    const { from, to } = visibleRange();
    if (to <= from) return;
    let low = Infinity;
    let high = -Infinity;
    for (let i = from; i < to; i++) {
      if (candles[i].l < low) low = candles[i].l;
      if (candles[i].h > high) high = candles[i].h;
    }
    if (reference) {
      low = Math.min(low, reference.price);
      high = Math.max(high, reference.price);
    }
    const margin = (high - low || high * 0.02) * 0.08;
    yTarget = { min: low - margin, max: high + margin };
    const unset = yMin === 0 && yMax === 1;
    if (reducedMotion || unset) {
      yMin = yTarget.min;
      yMax = yTarget.max;
    }
  }

  function schedule() {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    clampView();
    retarget();
    let settling = false;
    if (yTarget) {
      const range = yMax - yMin;
      const ease = reducedMotion ? 1 : 0.28;
      yMin += (yTarget.min - yMin) * ease;
      yMax += (yTarget.max - yMax) * ease;
      settling = Math.abs(yTarget.min - yMin) > range * 0.0005 || Math.abs(yTarget.max - yMax) > range * 0.0005;
      if (!settling) {
        yMin = yTarget.min;
        yMax = yTarget.max;
      }
    }
    draw();
    positionMarkers();
    maybeAskHistory();
    if (settling) schedule();
  }

  function maybeAskHistory() {
    if (candles.length === 0) return;
    const now = performance.now();
    if (tLeft < candles[0].t + HISTORY_MARGIN_BARS * intervalMs && now - lastHistoryAsk > 700) {
      lastHistoryAsk = now;
      handlers.onNeedHistory?.();
    }
  }

  function drawGrid(p) {
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const priceStep = niceStep(yMax - yMin, Math.max(3, Math.floor((p.priceBottom - p.top) / 56)));
    decimals = decimalsFor(priceStep);
    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.text;
    ctx.lineWidth = 1;
    ctx.textAlign = 'left';
    ctx.beginPath();
    for (let price = Math.ceil(yMin / priceStep) * priceStep; price <= yMax; price += priceStep) {
      const y = Math.round(yOf(price)) + 0.5;
      ctx.moveTo(p.left, y);
      ctx.lineTo(p.right, y);
    }
    ctx.stroke();
    for (let price = Math.ceil(yMin / priceStep) * priceStep; price <= yMax; price += priceStep) {
      ctx.fillText(formatPrice(price, decimals), p.right + 8, yOf(price));
    }

    const minGap = 96;
    const step = TIME_STEPS.find((candidate) => (candidate * barPx) / intervalMs >= minGap) ?? TIME_STEPS[TIME_STEPS.length - 1];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tRight = tLeft + spanT();
    ctx.beginPath();
    for (let t = Math.ceil(tLeft / step) * step; t <= tRight; t += step) {
      const x = Math.round(xLeftEdge(t)) + 0.5;
      ctx.moveTo(x, p.top);
      ctx.lineTo(x, p.bottom);
    }
    ctx.stroke();
    for (let t = Math.ceil(tLeft / step) * step; t <= tRight; t += step) {
      ctx.fillText(tickLabel(t, step), xLeftEdge(t), p.bottom + 7);
    }
  }

  function drawSeries(p) {
    const { from, to } = visibleRange();
    if (to <= from) return;
    let maxVolume = 0;
    for (let i = from; i < to; i++) maxVolume = Math.max(maxVolume, candles[i].v);
    const bodyW = Math.max(1, Math.floor(barPx * 0.72));

    for (let i = from; i < to; i++) {
      const c = candles[i];
      const cx = xCenter(c.t);
      if (cx < p.left - barPx || cx > p.right + barPx) continue;
      const up = c.c >= c.o;
      ctx.fillStyle = up ? colors.up : colors.down;
      if (maxVolume > 0) {
        const h = Math.max(1, (c.v / maxVolume) * (p.bottom - p.volumeTop));
        ctx.globalAlpha = 0.32;
        ctx.fillRect(Math.round(cx - bodyW / 2), Math.round(p.bottom - h), bodyW, Math.round(h));
        ctx.globalAlpha = 1;
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(p.left, p.top, p.width, p.priceBottom - p.top + 1);
    ctx.clip();
    if (type === 'line') {
      ctx.beginPath();
      let started = false;
      for (let i = from; i < to; i++) {
        const x = xCenter(candles[i].t);
        const y = yOf(candles[i].c);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else {
      for (let i = from; i < to; i++) {
        const c = candles[i];
        const cx = xCenter(c.t);
        const up = c.c >= c.o;
        const color = up ? colors.up : colors.down;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        const wickX = Math.round(cx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(wickX, yOf(c.h));
        ctx.lineTo(wickX, yOf(c.l));
        ctx.stroke();
        if (barPx >= 3) {
          const top = yOf(Math.max(c.o, c.c));
          const bodyH = Math.max(1, Math.abs(yOf(c.o) - yOf(c.c)));
          ctx.fillRect(Math.round(cx - bodyW / 2), Math.round(top), bodyW, Math.round(bodyH));
        }
      }
    }
    ctx.restore();
  }

  function axisLabel(text, x, y, fill) {
    ctx.font = '11px Inter, system-ui, sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y - 9, w, 18);
    ctx.fillStyle = '#0d0614';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y);
    return w;
  }

  function drawOverlays(p) {
    const last = candles[candles.length - 1];
    if (last) {
      const y = yOf(last.c);
      if (y >= p.top && y <= p.priceBottom) {
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = last.c >= last.o ? colors.up : colors.down;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(p.left, Math.round(y) + 0.5);
        ctx.lineTo(p.right, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.restore();
        axisLabel(formatPrice(last.c, decimals), p.right + 2, y, last.c >= last.o ? colors.up : colors.down);
      }
    }

    if (reference && selectionT != null) {
      const y = yOf(reference.price);
      const x0 = xCenter(reference.t);
      const x1 = xCenter(selectionT);
      ctx.save();
      ctx.strokeStyle = colors.accent;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.restore();
    }

    const selected = selectionT != null ? candles[indexAtTime(candles, intervalMs, selectionT)] : null;
    if (selected) {
      const x = Math.round(xCenter(selected.t)) + 0.5;
      ctx.save();
      ctx.fillStyle = 'rgba(138,107,216,0.10)';
      ctx.fillRect(x - Math.max(barPx / 2, 2), p.top, Math.max(barPx, 4), p.bottom - p.top);
      ctx.strokeStyle = 'rgba(224,112,176,0.55)';
      ctx.beginPath();
      ctx.moveTo(x, p.top);
      ctx.lineTo(x, p.bottom);
      ctx.stroke();
      ctx.restore();
    }

    if (hover) {
      const x = Math.round(hover.x) + 0.5;
      const y = Math.round(hover.y) + 0.5;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (hover.y <= p.priceBottom) {
        ctx.moveTo(p.left, y);
        ctx.lineTo(p.right, y);
      }
      ctx.moveTo(x, p.top);
      ctx.lineTo(x, p.bottom);
      ctx.stroke();
      ctx.restore();
      if (hover.y <= p.priceBottom) axisLabel(formatPrice(priceAt(hover.y), decimals), p.right + 2, hover.y, '#d8d3e0');
      const snapped = candles[indexAtTime(candles, intervalMs, timeAt(hover.x))];
      if (snapped) {
        const label = formatUtc(snapped.t, intervalMs < DAY);
        ctx.font = '11px Inter, system-ui, sans-serif';
        const w = ctx.measureText(label).width + 12;
        const lx = clamp(xCenter(snapped.t) - w / 2, p.left, p.right - w);
        ctx.fillStyle = '#d8d3e0';
        ctx.fillRect(lx, p.bottom + 3, w, 18);
        ctx.fillStyle = '#0d0614';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + 6, p.bottom + 12);
      }
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (candles.length === 0 || yMax <= yMin) return;
    const p = plot();
    drawGrid(p);
    drawSeries(p);
    drawOverlays(p);
  }

  function barAtX(x) {
    const index = indexAtTime(candles, intervalMs, timeAt(x));
    return index >= 0 ? candles[index] : null;
  }

  function renderReadout() {
    const t = hover ? barAtX(hover.x)?.t : selectionT;
    const bar = t != null ? candles[indexAtTime(candles, intervalMs, t)] : candles[candles.length - 1];
    if (!bar) {
      readout.textContent = '';
      return;
    }
    const change = ((bar.c - bar.o) / bar.o) * 100;
    const d = Math.max(decimals, 2);
    const parts = [
      ['', formatUtc(bar.t, intervalMs < DAY)],
      ['O', formatPrice(bar.o, d)], ['H', formatPrice(bar.h, d)], ['L', formatPrice(bar.l, d)], ['C', formatPrice(bar.c, d)],
      ['Vol', formatVolume(bar.v)], ['', `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`],
    ];
    readout.replaceChildren(
      ...parts.map(([label, value], i) => {
        const span = document.createElement('span');
        if (i === parts.length - 1) span.className = change >= 0 ? 'is-up' : 'is-down';
        span.textContent = label ? `${label} ${value}` : value;
        return span;
      }),
    );
  }

  function positionMarkers() {
    const p = plot();
    for (const [t, node] of markerNodes) {
      const bar = candles[indexAtTime(candles, intervalMs, t)];
      const price = Number(node.dataset.price);
      const x = xCenter(t);
      const y = yOf(price);
      const inside = bar && x >= p.left && x <= p.right && y >= p.top && y <= p.priceBottom;
      node.hidden = !inside;
      if (inside) node.style.transform = `translate(${x - MARKER_SIZE / 2}px, ${y - MARKER_SIZE / 2}px)`;
    }
    renderReadout();
  }

  function syncMarkers() {
    const wanted = new Map();
    const add = (t, price, role, title, eventIds = []) => {
      const entry = wanted.get(t) ?? { price, roles: new Set(), titles: [], eventIds: [] };
      if (role === 'event' || entry.roles.size === 0) entry.price = price;
      entry.roles.add(role);
      if (title) entry.titles.push(title);
      entry.eventIds.push(...eventIds);
      wanted.set(t, entry);
    };
    for (const event of events) if (event.kind !== 'period_high' && event.kind !== 'period_low') add(event.t, event.price, 'event', event.summary, [event.id]);
    for (const event of events) if (event.kind === 'period_high' || event.kind === 'period_low') add(event.t, event.price, 'extreme', event.summary, [event.id]);
    const barOf = (t) => candles[indexAtTime(candles, intervalMs, t)];
    if (selectionT != null && barOf(selectionT)) add(selectionT, barOf(selectionT).c, 'selected', 'Selected bar');
    if (reference && barOf(reference.t)) add(reference.t, reference.price, 'reference', reference.label);
    if (lastT != null && barOf(lastT)) add(lastT, barOf(lastT).c, 'last', 'Latest bar');

    for (const [t, node] of markerNodes) {
      if (!wanted.has(t)) {
        node.remove();
        markerNodes.delete(t);
      }
    }
    for (const [t, entry] of wanted) {
      let node = markerNodes.get(t);
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.className = 'chart-marker';
        node.dataset.spiderId = markerId(t);
        node.dataset.spiderPad = String(SPIDER_STAND_OFF);
        node.dataset.barTime = String(t);
        node.addEventListener('click', (event) => {
          event.stopPropagation();
          handlers.onMarker?.(t, node.dataset.eventIds ? node.dataset.eventIds.split(',') : []);
        });
        node.addEventListener('pointerdown', (event) => event.stopPropagation());
        markersLayer.append(node);
        markerNodes.set(t, node);
      }
      node.dataset.price = String(entry.price);
      node.dataset.eventIds = entry.eventIds.join(',');
      node.className = `chart-marker ${[...entry.roles].map((role) => `is-${role}`).join(' ')}${entry.eventIds.length ? ' has-events' : ''}`;
      node.setAttribute('aria-label', `${formatUtc(t, intervalMs < DAY)}: ${entry.titles.join('; ')}`);
      node.tabIndex = entry.eventIds.length ? 0 : -1;
      node.title = entry.titles.join('\n');
    }
    schedule();
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    width = Math.max(0, Math.floor(rect.width));
    height = Math.max(0, Math.floor(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (!fitted && width > 0 && candles.length) api.fit();
    schedule();
  }

  function zoomAt(x, factor) {
    if (candles.length === 0) return;
    const anchorT = timeAt(x);
    barPx = clamp(barPx * factor, MIN_BAR_PX, MAX_BAR_PX);
    tLeft = anchorT - ((x - plot().left) * intervalMs) / barPx;
    schedule();
  }

  function panBy(dx) {
    tLeft -= (dx * intervalMs) / barPx;
    schedule();
  }

  function select(t) {
    handlers.onSelectTime?.(t);
  }

  function stepSelection(direction) {
    if (candles.length === 0) return;
    const current = selectionT != null ? indexAtTime(candles, intervalMs, selectionT) : candles.length;
    const next = clamp(current + direction, 0, candles.length - 1);
    select(candles[next].t);
  }

  function localPoint(event) {
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, localPoint(event));
    container.focus({ preventScroll: true });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), barPx };
      drag = null;
    } else {
      drag = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, moved: false, id: event.pointerId };
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const point = localPoint(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const centerX = (a.x + b.x) / 2;
      zoomAt(centerX, (pinch.barPx * (distance / pinch.distance)) / barPx);
      return;
    }
    if (drag && drag.id === event.pointerId) {
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4) {
        drag.moved = true;
        canvas.classList.add('is-dragging');
      }
      if (drag.moved) {
        panBy(event.clientX - drag.lastX);
        drag.lastX = event.clientX;
        hover = null;
        return;
      }
    }
    if (event.pointerType === 'mouse') {
      hover = point;
      schedule();
    }
  });

  function endPointer(event, cancelled) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    canvas.classList.remove('is-dragging');
    if (drag && drag.id === event.pointerId) {
      if (!drag.moved && !cancelled) {
        const bar = barAtX(localPoint(event).x);
        if (bar) select(bar.t);
      }
      drag = null;
    }
  }
  canvas.addEventListener('pointerup', (event) => endPointer(event, false));
  canvas.addEventListener('pointercancel', (event) => endPointer(event, true));
  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') {
      hover = null;
      schedule();
    }
  });
  canvas.addEventListener('dblclick', () => api.fit());

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : 1;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
      panBy(-(event.deltaX || event.deltaY) * scale);
    } else {
      zoomAt(localPoint(event).x, Math.exp(-event.deltaY * scale * 0.0015));
    }
  }, { passive: false });

  container.addEventListener('keydown', (event) => {
    if (event.target !== container) return;
    const keys = {
      ArrowLeft: () => stepSelection(-1),
      ArrowRight: () => stepSelection(1),
      '+': () => zoomAt(plot().left + plot().width / 2, 1.25),
      '=': () => zoomAt(plot().left + plot().width / 2, 1.25),
      '-': () => zoomAt(plot().left + plot().width / 2, 0.8),
      Home: () => api.revealTime(candles[0]?.t),
      End: () => api.latest(),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  new ResizeObserver(resize).observe(container);

  const api = {
    get candles() { return candles; },
    get intervalMs() { return intervalMs; },
    get decimals() { return decimals; },
    canvas,
    container,
    xCenter,
    yOf,
    plot,
    indexAtTime: (t) => indexAtTime(candles, intervalMs, t),
    candleAt: (t) => candles[indexAtTime(candles, intervalMs, t)] ?? null,
    getView() {
      const span = spanT();
      return { from: tLeft, to: tLeft + span, following: lastT != null && tLeft + span >= lastT + intervalMs };
    },
    setData({ candles: next, intervalMs: nextInterval, resetView = false }) {
      const previousLast = candles.length ? candles[candles.length - 1].t : null;
      const wasFollowing = candles.length > 0 && api.getView().following;
      const intervalChanged = nextInterval !== intervalMs;
      candles = next;
      intervalMs = nextInterval;
      lastT = candles.length ? candles[candles.length - 1].t : null;
      if (resetView || intervalChanged) {
        yMin = 0;
        yMax = 1;
        api.fit();
      } else if (wasFollowing && previousLast != null && lastT > previousLast) {
        tLeft += lastT - previousLast;
      }
      syncMarkers();
      schedule();
    },
    setEvents(next) {
      events = next;
      syncMarkers();
    },
    setSelection(t) {
      selectionT = t;
      syncMarkers();
      const bar = t != null ? api.candleAt(t) : null;
      if (bar) announce.textContent = `${formatUtc(bar.t, intervalMs < DAY)}, open ${bar.o}, high ${bar.h}, low ${bar.l}, close ${bar.c}, volume ${formatVolume(bar.v)}`;
    },
    setReference(next) {
      reference = next;
      syncMarkers();
    },
    setType(next) {
      type = next;
      schedule();
    },
    get type() { return type; },
    zoom(factor) {
      zoomAt(plot().left + plot().width / 2, factor);
    },
    fit() {
      if (candles.length === 0) return;
      fitted = width > 0;
      barPx = width < 520 ? 7 : 9;
      tLeft = lastT + intervalMs * 6 - spanT();
      schedule();
    },
    latest() {
      tLeft = lastT + intervalMs * 6 - spanT();
      schedule();
    },
    revealTime(t) {
      if (t == null) return;
      const margin = spanT() * 0.12;
      if (t >= tLeft + margin && t <= tLeft + spanT() - margin) return;
      tLeft = t - spanT() / 2;
      schedule();
    },
    revealRange(a, b) {
      if (a == null) return;
      if (b == null) {
        api.revealTime(a);
        return;
      }
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const span = spanT();
      const margin = span * 0.12;
      if (lo >= tLeft + margin && hi <= tLeft + span - margin) return;
      tLeft = hi - lo < span * 0.76 ? (lo + hi) / 2 - span / 2 + intervalMs / 2 : a - span / 2;
      schedule();
    },
    flush() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      dirty = true;
      frame();
    },
    isVisible(t) {
      const p = plot();
      const x = xCenter(t);
      return x >= p.left && x <= p.right;
    },
    markerElement: (t) => markerNodes.get(t) ?? null,
    stepSelection,
    resize,
    schedule,
    destroy() {
      cancelAnimationFrame(raf);
    },
  };
  resize();
  return api;
}
