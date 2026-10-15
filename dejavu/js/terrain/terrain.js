import { buildGraph, layoutGraph, nearestNode, shortestPath } from './graph.js';

const LIGHT = '255, 130, 215';
const SPARK = '255, 238, 250';
const LAVENDER = '205, 185, 255';

const FOOT_REACH = 110;
const SCAN_REACH = 240;
const FOOT_COOLDOWN = 0.14;
const MAX_FOOT_STRIKES = 3;
const MAX_HEADS = 10;
const MAX_SEGMENTS = 360;
const PATH_LIFETIME = 14;

const now = () => performance.now() / 1000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const choice = (list) => list[Math.floor(Math.random() * list.length)];

function parseFocus(objectPosition) {
  const [x = '50%', y = '40%'] = objectPosition.trim().split(/\s+/);
  return { focusX: parseFloat(x) / 100, focusY: parseFloat(y) / 100 };
}

function traceEdge(ctx, edge, from) {
  const start = from ?? edge.a;
  const end = start === edge.a ? edge.b : edge.a;
  ctx.moveTo(start.x, start.y);
  if (edge.kind === 'cross') ctx.quadraticCurveTo(edge.cx, edge.cy, end.x, end.y);
  else ctx.lineTo(end.x, end.y);
}

export class TerrainLight {
  constructor(canvas, { reducedMotion = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.reduced = reducedMotion;
    this.graph = buildGraph();
    this.base = document.createElement('canvas');
    this.heads = [];
    this.segments = [];
    this.leads = [];
    this.flashes = [];
    this.waves = [];
    this.paths = [];
    this.lastFoot = 0;
    this.raf = 0;
    this.lastFrame = 0;
    this.width = 0;
    this.height = 0;
    this.detach = () => {};
    this.frame = this.frame.bind(this);
    this.resize = this.resize.bind(this);
  }

  start() {
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('resize', this.resize);
    this.detach();
  }

  attach(spider) {
    spider.onFootPlant = (event) => this.footPlant(event);
    spider.onTouch = (event) => this.touch(event);
    spider.onLink = (a, b) => this.connect(a, b);
    this.detach = () => {
      spider.onFootPlant = null;
      spider.onTouch = null;
      spider.onLink = null;
    };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    for (const canvas of [this.canvas, this.base]) {
      canvas.width = Math.round(this.width * dpr);
      canvas.height = Math.round(this.height * dpr);
    }
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.base.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);

    const focus = parseFocus(getComputedStyle(document.documentElement).getPropertyValue('--bg-focus') || '50% 40%');
    layoutGraph(this.graph, { width: this.width, height: this.height, ...focus });
    this.drawBase();
    this.wake();
  }

  drawBase() {
    const ctx = this.base.getContext('2d');
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.lineCap = 'round';
    for (const edge of this.graph.edges) {
      ctx.strokeStyle = `rgba(${LIGHT}, ${0.025 + 0.075 * edge.depth})`;
      ctx.lineWidth = 0.5 + 0.5 * edge.depth;
      ctx.beginPath();
      traceEdge(ctx, edge);
      ctx.stroke();
    }
  }

  visible() {
    return this.canvas.offsetParent !== null;
  }

  footPlant({ x, y }) {
    if (this.reduced || !this.visible()) return;
    const t = now();
    if (t - this.lastFoot < FOOT_COOLDOWN) return;
    if (this.leads.length >= MAX_FOOT_STRIKES) return;
    if (Math.random() > 0.5) return;
    const node = nearestNode(this.graph, x, y, FOOT_REACH);
    if (!node) return;
    this.lastFoot = t;
    this.spawnStrike({ x, y }, node, { power: 0.7, hops: 7, speed: 16, branch: 0.05, both: false });
  }

  touch({ x, y, tone, scan }) {
    if (this.reduced || !this.visible()) return;
    if (!scan) {
      const node = nearestNode(this.graph, x, y, FOOT_REACH * 1.4);
      if (node) this.spawnStrike({ x, y }, node, { power: 0.85, hops: 9, speed: 16, branch: 0.08, both: false });
      return;
    }
    const finding = tone === 'finding';
    const node = nearestNode(this.graph, x, y, SCAN_REACH);
    if (!node) return;
    const radius = finding ? 360 : 250;
    const t = now();
    const edges = [];
    for (const edge of this.graph.edges) {
      const d = Math.hypot((edge.a.x + edge.b.x) / 2 - node.x, (edge.a.y + edge.b.y) / 2 - node.y);
      if (d < radius) edges.push({ edge, d });
    }
    this.waves.push({ x: node.x, y: node.y, born: t, radius, speed: finding ? 560 : 480, life: finding ? 2 : 1.5, edges, finding });
    this.spawnStrike({ x, y }, node, {
      power: finding ? 1.25 : 1,
      hops: finding ? 22 : 16,
      speed: 18,
      branch: finding ? 0.22 : 0.14,
      both: true,
    });
  }

  connect(elementA, elementB) {
    if (!this.visible()) return;
    const pointOf = (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const a = pointOf(elementA);
    const b = pointOf(elementB);
    const from = nearestNode(this.graph, a.x, a.y, Infinity);
    const to = nearestNode(this.graph, b.x, b.y, Infinity);
    if (!from || !to || from === to) return;
    const steps = shortestPath(this.graph, from, to);
    if (!steps?.length) return;
    const total = steps.reduce((sum, step) => sum + step.edge.length, 0);
    this.paths.push({ steps, total, born: now(), life: PATH_LIFETIME, demo: true });
    this.paths.splice(0, Math.max(0, this.paths.length - 4));
    this.wake();
  }

  spawnStrike(point, node, { power, hops, speed, branch, both }) {
    const t = now();
    this.leads.push({ x: point.x, y: point.y, node, born: t, life: 0.2, power });
    this.flashes.push({ x: point.x, y: point.y, born: t, life: 0.24, power });

    const along = node.edges.filter((edge) => edge.kind === 'along');
    if (along.length === 0) return this.wake();
    const first = choice(along);
    const directions = both && along.length > 1 ? [first, along.find((edge) => edge !== first)] : [first];
    for (const edge of directions) {
      if (this.heads.length >= MAX_HEADS) break;
      this.heads.push({ node, edge, pending: edge, hops: 0, maxHops: hops, power, speed, acc: 0, branch, life: both ? 1.5 : 0.9 });
    }
    this.wake();
  }

  wake() {
    if (this.raf) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  hasEffects() {
    return (
      this.heads.length + this.segments.length + this.leads.length +
      this.flashes.length + this.waves.length + this.paths.length > 0
    );
  }

  frame(time) {
    this.raf = 0;
    const dt = Math.min((time - this.lastFrame) / 1000, 0.05);
    this.lastFrame = time;
    this.update(dt);
    this.draw();
    if (this.hasEffects()) this.raf = requestAnimationFrame(this.frame);
  }

  update(dt) {
    const t = now();
    for (const head of [...this.heads]) {
      head.acc += dt * head.speed;
      while (head.acc >= 1 && this.heads.includes(head)) {
        head.acc -= 1;
        this.advance(head, t);
      }
    }
    this.segments = this.segments.filter((segment) => t - segment.born < segment.life);
    this.leads = this.leads.filter((lead) => t - lead.born < lead.life);
    this.flashes = this.flashes.filter((flash) => t - flash.born < flash.life);
    this.waves = this.waves.filter((wave) => t - wave.born < wave.life);
    this.paths = this.paths.filter((path) => t - path.born < path.life);
  }

  advance(head, t) {
    const edge = head.pending ?? this.nextEdge(head);
    head.pending = null;
    if (!edge) return this.retire(head);
    const next = edge.a === head.node ? edge.b : edge.a;
    this.segments.push({ edge, from: head.node, born: t, life: head.life, power: head.power, hop: head.hops, maxHops: head.maxHops });
    if (this.segments.length > MAX_SEGMENTS) this.segments.shift();

    if (head.branch > 0 && Math.random() < head.branch && this.heads.length < MAX_HEADS) {
      const cross = next.edges.filter((candidate) => candidate.kind === 'cross' && candidate !== edge);
      if (cross.length) {
        this.heads.push({
          node: next, edge: null, pending: choice(cross), hops: head.hops + 1,
          maxHops: Math.min(head.maxHops, head.hops + 6), power: head.power * 0.7,
          speed: head.speed, acc: 0, branch: 0, life: head.life,
        });
      }
    }

    head.node = next;
    head.edge = edge;
    head.hops += 1;
    if (head.hops >= head.maxHops) this.retire(head);
  }

  nextEdge(head) {
    const options = head.node.edges.filter((edge) => edge.kind === 'along' && edge !== head.edge);
    if (options.length) return options[0];
    const cross = head.node.edges.filter((edge) => edge.kind === 'cross' && edge !== head.edge);
    return cross.length && Math.random() < 0.5 ? choice(cross) : null;
  }

  retire(head) {
    const index = this.heads.indexOf(head);
    if (index >= 0) this.heads.splice(index, 1);
  }

  draw() {
    const ctx = this.ctx;
    const t = now();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.base, 0, 0, this.width, this.height);
    if (!this.hasEffects()) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    this.drawWaves(ctx, t);
    this.drawSegments(ctx, t);
    this.drawPaths(ctx, t);
    this.drawLeads(ctx, t);
    this.drawHeads(ctx);
    this.drawFlashes(ctx, t);
    ctx.restore();
  }

  drawWaves(ctx, t) {
    for (const wave of this.waves) {
      const age = t - wave.born;
      const front = age * wave.speed;
      const fade = Math.pow(1 - age / wave.life, 1.4);
      for (const { edge, d } of wave.edges) {
        if (front < d) continue;
        const reach = Math.pow(1 - d / wave.radius, 1.3);
        const trail = clamp(1 - (front - d) / (wave.radius * 0.55), 0, 1);
        const alpha = reach * trail * fade * (wave.finding ? 0.5 : 0.36);
        if (alpha < 0.01) continue;
        ctx.strokeStyle = `rgba(${LIGHT}, ${alpha})`;
        ctx.lineWidth = 0.8 + 0.6 * edge.depth;
        ctx.beginPath();
        traceEdge(ctx, edge);
        ctx.stroke();
      }
    }
  }

  drawSegments(ctx, t) {
    for (const segment of this.segments) {
      const age = (t - segment.born) / segment.life;
      const reach = Math.pow(1 - segment.hop / segment.maxHops, 1.4);
      const alpha = segment.power * reach * Math.pow(1 - age, 1.5);
      if (alpha < 0.01) continue;
      const depth = segment.edge.depth;
      ctx.beginPath();
      traceEdge(ctx, segment.edge, segment.from);
      ctx.strokeStyle = `rgba(${LIGHT}, ${alpha * 0.18})`;
      ctx.lineWidth = 2.6 + 1.4 * depth;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${SPARK}, ${alpha * 0.85})`;
      ctx.lineWidth = 0.7 + 0.6 * depth;
      ctx.stroke();
    }
  }

  drawPaths(ctx, t) {
    for (const path of this.paths) {
      const age = t - path.born;
      const progress = clamp(age / 0.9, 0, 1) * path.total;
      const fade = clamp((path.life - age) / 2, 0, 1);
      ctx.strokeStyle = `rgba(${LAVENDER}, ${0.8 * fade})`;
      ctx.shadowColor = `rgba(${LAVENDER}, ${0.8 * fade})`;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 1.6;
      ctx.setLineDash(path.demo ? [6, 5] : []);
      let travelled = 0;
      for (const step of path.steps) {
        if (progress > travelled + step.edge.length * 0.5) {
          ctx.beginPath();
          traceEdge(ctx, step.edge, step.from);
          ctx.stroke();
        }
        travelled += step.edge.length;
      }
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      const ends = [path.steps[0].from, path.steps[path.steps.length - 1].to];
      for (const end of ends) {
        ctx.beginPath();
        ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  drawLeads(ctx, t) {
    for (const lead of this.leads) {
      const age = (t - lead.born) / lead.life;
      const alpha = lead.power * Math.pow(1 - age, 2);
      const dx = lead.node.x - lead.x;
      const dy = lead.node.y - lead.y;
      ctx.strokeStyle = `rgba(${SPARK}, ${alpha * 0.9})`;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(lead.x, lead.y);
      ctx.quadraticCurveTo((lead.x + lead.node.x) / 2 - dy * 0.25, (lead.y + lead.node.y) / 2 + dx * 0.25, lead.node.x, lead.node.y);
      ctx.stroke();
    }
  }

  drawHeads(ctx) {
    for (const head of this.heads) {
      const reach = Math.pow(1 - head.hops / head.maxHops, 1.2);
      ctx.fillStyle = `rgba(${SPARK}, ${0.9 * head.power * reach})`;
      ctx.shadowColor = `rgba(${LIGHT}, 1)`;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(head.node.x, head.node.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  drawFlashes(ctx, t) {
    for (const flash of this.flashes) {
      const age = (t - flash.born) / flash.life;
      const radius = 4 + age * 12;
      const glow = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, radius);
      glow.addColorStop(0, `rgba(${SPARK}, ${0.85 * flash.power * (1 - age)})`);
      glow.addColorStop(0.5, `rgba(${LIGHT}, ${0.35 * flash.power * (1 - age)})`);
      glow.addColorStop(1, `rgba(${LIGHT}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(flash.x, flash.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
