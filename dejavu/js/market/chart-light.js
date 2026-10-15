import { TONES } from '../spider/spider.js';

const STRIKE_BARS = { touch: 6, select: 9, finding: 12, fail: 4, link: 6 };
const BARS_PER_SECOND = 26;
const STRIKE_LIFE = 1.5;
const LEAD_LIFE = 0.35;
const WAVE_LIFE = 1.0;
const RAY_LIFE = 2.2;
const TRACE_DRAW = 0.7;
const TRACE_LIFE = 7;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * Light that travels along the real series. A strike starts at the data point the spider touched (the marker's own
 * bar and price) and runs along the close-price path of the neighbouring bars; a scan draws that bar's price level and
 * time. Nothing here is placed by hand or interpolated beyond straight segments between actual closes.
 */
export function createChartLight({ chart, reducedMotion }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'chart-light';
  canvas.setAttribute('aria-hidden', 'true');
  chart.container.insertBefore(canvas, chart.container.querySelector('.chart-markers'));
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let effects = [];

  function resize() {
    const rect = chart.container.getBoundingClientRect();
    width = Math.floor(rect.width);
    height = Math.floor(rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  new ResizeObserver(resize).observe(chart.container);
  resize();

  function wake() {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    for (const effect of effects) effect.age += dt;
    effects = effects.filter((effect) => effect.age < effect.life);
    draw();
    if (effects.length) raf = requestAnimationFrame(frame);
  }

  const rgb = (tone) => TONES[tone] ?? TONES.touch;

  function closePoint(index) {
    const bar = chart.candles[index];
    return { x: chart.xCenter(bar.t), y: chart.yOf(bar.c) };
  }

  function drawStrike(effect) {
    const index = chart.indexAtTime(effect.t);
    if (index < 0) return;
    const reach = STRIKE_BARS[effect.tone] ?? 6;
    const progress = Math.min(reach, effect.age * BARS_PER_SECOND);
    const fade = 1 - clamp01((effect.age - 0.35) / (STRIKE_LIFE - 0.35));
    const color = rgb(effect.tone);
    const origin = effect.price != null ? { x: chart.xCenter(effect.t), y: chart.yOf(effect.price) } : closePoint(index);

    for (const side of [-1, 1]) {
      let previous = origin;
      for (let k = 1; k <= Math.ceil(progress); k++) {
        const next = chart.candles[index + side * k];
        if (!next) break;
        const point = { x: chart.xCenter(next.t), y: chart.yOf(next.c) };
        const portion = Math.min(1, progress - (k - 1));
        const end = { x: previous.x + (point.x - previous.x) * portion, y: previous.y + (point.y - previous.y) * portion };
        const alpha = fade * (1 - (k - 1) / (reach + 2));
        ctx.lineCap = 'round';
        ctx.strokeStyle = `rgba(${color}, ${alpha * 0.28})`;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(255, 245, 252, ${alpha * 0.95})`;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        if (portion < 1 || k === Math.ceil(progress)) {
          ctx.fillStyle = `rgba(255, 245, 252, ${alpha})`;
          ctx.beginPath();
          ctx.arc(end.x, end.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        previous = point;
      }
    }

    const ring = clamp01(effect.age / 0.5);
    ctx.strokeStyle = `rgba(${color}, ${(1 - ring) * 0.9})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 4 + ring * 20, 0, Math.PI * 2);
    ctx.stroke();

    if (effect.lead) {
      const lead = clamp01(1 - effect.age / LEAD_LIFE);
      if (lead > 0) {
        ctx.strokeStyle = `rgba(${color}, ${lead * 0.8})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(effect.lead.x, effect.lead.y);
        ctx.lineTo(origin.x, origin.y);
        ctx.stroke();
      }
    }
  }

  function drawScan(effect) {
    const bar = chart.candleAt(effect.t);
    if (!bar) return;
    const p = chart.plot();
    const color = rgb(effect.tone);
    const x = chart.xCenter(effect.t);
    const y = chart.yOf(effect.price ?? bar.c);

    const wave = clamp01(effect.age / WAVE_LIFE);
    if (wave < 1) {
      ctx.strokeStyle = `rgba(${color}, ${(1 - wave) * 0.55})`;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, 10 + wave * 150, 0, Math.PI * 2);
      ctx.stroke();
    }

    const ray = 1 - clamp01(effect.age / RAY_LIFE);
    const reveal = clamp01(effect.age / 0.35);
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${color}, ${ray * 0.8})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (p.right - x) * reveal, y);
    ctx.moveTo(x, y);
    ctx.lineTo(x - (x - p.left) * reveal, y);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${color}, ${ray * 0.5})`;
    ctx.beginPath();
    ctx.moveTo(x, p.top);
    ctx.lineTo(x, p.bottom);
    ctx.stroke();
    ctx.restore();
  }

  function drawTrace(effect) {
    const from = chart.indexAtTime(effect.t1);
    const to = chart.indexAtTime(effect.t2);
    if (from < 0 || to < 0 || from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const color = rgb(effect.tone);
    const drawn = clamp01(effect.age / TRACE_DRAW);
    const fade = 1 - clamp01((effect.age - TRACE_DRAW) / (TRACE_LIFE - TRACE_DRAW));
    const count = Math.max(1, Math.floor((b - a) * drawn));
    ctx.lineJoin = 'round';
    ctx.strokeStyle = `rgba(${color}, ${fade * 0.35})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    for (let i = 0; i <= count; i++) {
      const point = closePoint(a + i);
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
    ctx.strokeStyle = `rgba(255, 245, 252, ${fade * 0.9})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const p = chart.plot();
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.left, p.top, p.width, p.bottom - p.top);
    ctx.clip();
    for (const effect of effects) {
      if (effect.kind === 'strike') drawStrike(effect);
      else if (effect.kind === 'scan') drawScan(effect);
      else drawTrace(effect);
    }
    ctx.restore();
  }

  function add(effect) {
    effects.push({ age: 0, ...effect });
    if (effects.length > 12) effects.shift();
    wake();
  }

  function barOf(el) {
    const t = Number(el?.dataset?.barTime);
    return Number.isFinite(t) ? t : null;
  }

  return {
    /** Called with the spider's touch. Only touches on chart markers produce light; reduced motion produces none. */
    onTouch({ el, tone, scan, x, y }) {
      const t = barOf(el);
      if (t == null || reducedMotion || !el.isConnected) return;
      const rect = chart.container.getBoundingClientRect();
      const price = Number(el.dataset.price);
      add({ kind: 'strike', t, price: Number.isFinite(price) ? price : null, tone, life: STRIKE_LIFE, lead: { x: x - rect.left, y: y - rect.top } });
      if (scan) add({ kind: 'scan', t, price: Number.isFinite(price) ? price : null, tone, life: RAY_LIFE });
    },
    /** Called when the spider links two elements. Two chart markers get the real close-price path between them lit. */
    onLink(a, b) {
      const t1 = barOf(a);
      const t2 = barOf(b);
      if (t1 == null || t2 == null || reducedMotion) return;
      add({ kind: 'trace', t1, t2, tone: 'link', life: TRACE_LIFE });
    },
    clear() {
      effects = [];
      draw();
    },
    get active() {
      return effects.length > 0;
    },
  };
}
