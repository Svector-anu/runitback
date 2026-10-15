import { solveFabrik } from './ik.js';
import { rectOf } from './geometry.js';

export const CANCELLED = Symbol('spider.cancelled');

const SCALE = window.innerWidth < 720 ? 1 : 1.35;
const BONES = [18, 28, 30].map((length) => length * SCALE);
const REACH = BONES.reduce((sum, length) => sum + length, 0);
const STEP_DISTANCE = 18 * SCALE;
const CRUISE_SPEED = 150;
const TURN_RATE = 5.5;
const ACCELERATION = 4;
const TRAIL_LIFETIME = 2.2;
const MAX_STRANDS = 28;
const MAX_LINKS = 12;

export const TONES = {
  touch: '224, 112, 176',
  select: '243, 166, 212',
  finding: '255, 190, 120',
  fail: '255, 100, 100',
  link: '160, 130, 235',
};

const LEG_DEFS = [1, -1].flatMap((side) =>
  [
    { hip: 12, angle: 35, reach: 60 },
    { hip: 5, angle: 70, reach: 66 },
    { hip: -3, angle: 105, reach: 64 },
    { hip: -11, angle: 140, reach: 58 },
  ].map((leg, index) => ({
    ...leg,
    hip: leg.hip * SCALE,
    reach: leg.reach * SCALE,
    side,
    angle: (leg.angle * Math.PI) / 180,
    group: (index + (side === 1 ? 0 : 1)) % 2,
  }))
);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const wrapAngle = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

export class Spider {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.reduced = reducedMotion;
    this.pos = { x: -80, y: 200 };
    this.vel = { x: 0, y: 0 };
    this.heading = 0;
    this.speed = 0;
    this.time = 0;
    this.goal = null;
    this.trail = [];
    this.trailClock = 0;
    this.strands = [];
    this.links = [];
    this.highlights = [];
    this.waiters = [];
    this.hidden = false;
    this.avoid = null;
    this.waypoint = null;
    this.onFootPlant = null;
    this.onTouch = null;
    this.onLink = null;
    this.legs = LEG_DEFS.map((def) => ({
      def,
      foot: { x: 0, y: 0 },
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      t: 1,
      dur: 0.15,
      swinging: false,
      joints: BONES.concat(0).map(() => ({ x: 0, y: 0 })),
    }));
    this.raf = 0;
    this.lastFrame = 0;
    this.width = 0;
    this.height = 0;
    this.frame = this.frame.bind(this);
    this.resize = this.resize.bind(this);
    this.wake = this.wake.bind(this);
  }

  start() {
    window.addEventListener('resize', this.resize);
    if (this.reduced) window.addEventListener('scroll', this.wake, { passive: true });
    this.resize();
    this.snapFeet();
    this.wake();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('scroll', this.wake);
    this.cancelGoal();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.wake();
  }

  wake() {
    if (this.raf) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  frame(now) {
    this.raf = 0;
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    this.update(dt);
    this.draw();
    if (!this.reduced || this.hasEffects() || this.goal) this.raf = requestAnimationFrame(this.frame);
  }

  hasEffects() {
    return this.strands.length > 0 || this.links.length > 0 || this.highlights.length > 0;
  }

  get screenPos() {
    return { x: this.pos.x - window.scrollX, y: this.pos.y - window.scrollY };
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) {
      this.cancelGoal();
      this.strands = [];
      this.trail = [];
    }
    this.wake();
  }

  placeAtScreen(x, y, heading = this.heading) {
    this.pos = { x: x + window.scrollX, y: y + window.scrollY };
    this.heading = heading;
    this.speed = 0;
    this.trail = [];
    this.snapFeet();
    this.wake();
  }

  rebase() {
    const { x, y } = this.screenPos;
    this.pos = { x: x + window.scrollX, y: y + window.scrollY };
  }

  walkTo(getPoint, { speed = 1, stopDistance = 10 } = {}) {
    this.cancelGoal();
    if (this.reduced) {
      const point = getPoint();
      if (point) {
        this.pos = { ...point };
        this.snapFeet();
      }
      this.wake();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.goal = { getPoint, speed, stopDistance, resolve, reject, wobblePhase: Math.random() * 6 };
      this.wake();
    });
  }

  cancelGoal() {
    this.waypoint = null;
    if (!this.goal) return;
    const { reject } = this.goal;
    this.goal = null;
    reject(CANCELLED);
  }

  flee(from) {
    const dx = this.pos.x - from.x;
    const dy = this.pos.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    const minY = window.scrollY + 60;
    const maxY = window.scrollY + this.height - 60;
    const target = {
      x: clamp(this.pos.x + (dx / dist) * 320, 60, Math.max(120, document.documentElement.scrollWidth - 60)),
      y: clamp(this.pos.y + (dy / dist) * 320, minY, maxY),
    };
    return this.walkTo(() => target, { speed: 2.8, stopDistance: 24 });
  }

  touch(el, { strands = 3, tone = 'touch', scan = false } = {}) {
    this.flash(el, tone);
    const screen = this.screenPos;
    this.onTouch?.({ x: screen.x, y: screen.y, tone, scan, el });
    for (let i = 0; i < strands; i++) {
      this.strands.push({
        el,
        fx: Math.random(),
        fy: Math.random() < 0.5 ? 0 : 1,
        ox: this.pos.x,
        oy: this.pos.y,
        life: 1.8,
        max: 1.8,
        tone,
      });
    }
    this.strands.splice(0, Math.max(0, this.strands.length - MAX_STRANDS));
    this.wake();
  }

  flash(el, tone = 'touch') {
    this.highlights = this.highlights.filter((item) => item.el !== el);
    this.highlights.push({ el, life: 1.4, max: 1.4, tone });
    this.wake();
  }

  link(a, b, tone = 'link') {
    this.onLink?.(a, b);
    this.links.push({ a, b, life: 12, max: 12, tone });
    this.links.splice(0, Math.max(0, this.links.length - MAX_LINKS));
    this.wake();
  }

  whenSettled(maxWait = 6000) {
    return new Promise((resolve) => {
      const waiter = { resolve, deadline: performance.now() + maxWait };
      this.waiters.push(waiter);
      this.wake();
    });
  }

  snapFeet() {
    const f = this.axes();
    for (const leg of this.legs) {
      const rest = this.restPoint(leg, f);
      leg.foot = { ...rest };
      leg.swinging = false;
      leg.t = 1;
    }
  }

  axes() {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    return { fx: c, fy: s, rx: -s, ry: c };
  }

  toWorld(f, x, y) {
    return { x: this.pos.x + f.fx * x + f.rx * y, y: this.pos.y + f.fy * x + f.ry * y };
  }

  hipPoint(leg, f) {
    return this.toWorld(f, leg.def.hip, leg.def.side * 4 * SCALE);
  }

  restPoint(leg, f) {
    const { hip, angle, reach, side } = leg.def;
    return this.toWorld(f, hip + Math.cos(angle) * reach, side * Math.sin(angle) * reach);
  }

  update(dt) {
    this.time += dt;
    this.steer(dt);
    this.stepLegs(dt);
    this.age(dt);
    this.notifyWaiters();
  }

  steer(dt) {
    let desiredSpeed = 0;
    const goal = this.goal;
    if (goal) {
      const wanted = goal.getPoint();
      const target = wanted && this.detour(wanted);
      if (!target) {
        this.cancelGoal();
      } else {
        const dx = target.x - this.pos.x;
        const dy = target.y - this.pos.y;
        const dist = Math.hypot(dx, dy);
        if (Math.hypot(wanted.x - this.pos.x, wanted.y - this.pos.y) <= goal.stopDistance) {
          this.goal = null;
          goal.resolve();
        } else {
          const wobble = 0.22 * Math.sin(this.time * 0.9 + goal.wobblePhase) * clamp(dist / 240, 0, 1);
          const diff = wrapAngle(Math.atan2(dy, dx) + wobble - this.heading);
          const turn = TURN_RATE * (this.speed < 40 ? 1.6 : 1) * dt;
          this.heading += clamp(diff, -turn, turn);
          const arrival = clamp(dist / 90, 0.3, 1);
          const alignment = Math.max(0.12, Math.cos(diff * 0.9));
          desiredSpeed = CRUISE_SPEED * goal.speed * arrival * alignment;
        }
      }
    }
    this.speed += (desiredSpeed - this.speed) * Math.min(1, ACCELERATION * dt);
    if (this.speed < 0.5) this.speed = 0;
    const f = this.axes();
    this.vel = { x: f.fx * this.speed, y: f.fy * this.speed };
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
  }

  detour(target) {
    const zone = this.avoid?.();
    if (!zone) {
      this.waypoint = null;
      return target;
    }
    const margin = 28;
    const box = { left: zone.left - margin, top: zone.top - margin, right: zone.right + margin, bottom: zone.bottom + margin };
    const inside = (p, shrink = 0) =>
      p.x > box.left + shrink && p.x < box.right - shrink && p.y > box.top + shrink && p.y < box.bottom - shrink;
    const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const crosses = (a, b) => {
      for (let i = 1; i <= 24; i++) {
        const t = i / 24;
        if (inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, 2)) return true;
      }
      return false;
    };
    if (this.waypoint) {
      if (length(this.pos, this.waypoint) > 16) return this.waypoint;
      this.waypoint = null;
    }
    if (inside(target) || inside(this.pos) || !crosses(this.pos, target)) return target;
    const corners = [
      { x: box.left, y: box.top }, { x: box.right, y: box.top },
      { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom },
    ].filter((corner) => length(this.pos, corner) > 20 && !crosses(this.pos, corner));
    if (corners.length === 0) return target;
    const cost = (corner) => length(this.pos, corner) + length(corner, target) + (crosses(corner, target) ? 2000 : 0);
    this.waypoint = corners.reduce((best, corner) => (cost(corner) < cost(best) ? corner : best));
    return this.waypoint;
  }

  stepLegs(dt) {
    const f = this.axes();
    const swinging = [false, false];
    for (const leg of this.legs) if (leg.swinging) swinging[leg.def.group] = true;

    for (const leg of this.legs) {
      if (leg.swinging) {
        leg.t += dt / leg.dur;
        if (leg.t >= 1) {
          leg.t = 1;
          leg.swinging = false;
          leg.foot = { ...leg.to };
          this.onFootPlant?.({
            x: leg.foot.x - window.scrollX,
            y: leg.foot.y - window.scrollY,
            speed: this.speed,
          });
        } else {
          const e = easeInOut(leg.t);
          leg.foot.x = lerp(leg.from.x, leg.to.x, e);
          leg.foot.y = lerp(leg.from.y, leg.to.y, e);
        }
        continue;
      }
      const rest = this.restPoint(leg, f);
      const hip = this.hipPoint(leg, f);
      const drift = Math.hypot(leg.foot.x - rest.x, leg.foot.y - rest.y);
      const stretch = Math.hypot(leg.foot.x - hip.x, leg.foot.y - hip.y);
      const blocked = swinging[1 - leg.def.group];
      if ((drift > STEP_DISTANCE && !blocked) || drift > STEP_DISTANCE * 2.2 || stretch > REACH * 0.97) {
        leg.from = { ...leg.foot };
        leg.to = { x: rest.x + this.vel.x * 0.1, y: rest.y + this.vel.y * 0.1 };
        leg.dur = clamp(0.22 - this.speed * 0.0003, 0.08, 0.22);
        leg.t = 0;
        leg.swinging = true;
        swinging[leg.def.group] = true;
      }
    }
  }

  age(dt) {
    this.trailClock += dt;
    if (this.trailClock > 0.04 && this.speed > 8) {
      this.trailClock = 0;
      this.trail.push({ x: this.pos.x, y: this.pos.y, age: 0 });
    }
    for (const point of this.trail) point.age += dt;
    while (this.trail.length && this.trail[0].age > TRAIL_LIFETIME) this.trail.shift();

    for (const list of [this.strands, this.links, this.highlights]) {
      for (const item of list) item.life -= dt;
      for (let i = list.length - 1; i >= 0; i--) {
        const anchor = list[i].el ?? list[i].a;
        if (list[i].life <= 0 || (anchor && !anchor.isConnected)) list.splice(i, 1);
      }
    }
  }

  notifyWaiters() {
    if (!this.waiters.length) return;
    const idle = !this.goal && this.speed < 8;
    const now = performance.now();
    this.waiters = this.waiters.filter((waiter) => {
      if (!idle && now < waiter.deadline) return true;
      waiter.resolve();
      return false;
    });
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    const sx = window.scrollX;
    const sy = window.scrollY;
    this.drawHighlights(ctx);
    if (this.hidden) return;
    this.drawTrail(ctx, sx, sy);
    this.drawStrands(ctx, sx, sy);
    this.drawLinks(ctx);
    this.drawLegs(ctx, sx, sy);
    this.drawBody(ctx, sx, sy);
  }

  drawTrail(ctx, sx, sy) {
    if (this.trail.length < 2) return;
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const alpha = clamp(1 - b.age / TRAIL_LIFETIME, 0, 1) * 0.35;
      ctx.strokeStyle = `rgba(${TONES.touch}, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.x - sx, a.y - sy);
      ctx.lineTo(b.x - sx, b.y - sy);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawStrands(ctx, sx, sy) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const strand of this.strands) {
      if (!strand.el.isConnected) continue;
      const rect = rectOf(strand.el);
      const ax = rect.left + rect.width * strand.fx;
      const ay = rect.top + rect.height * strand.fy;
      const ox = strand.ox - sx;
      const oy = strand.oy - sy;
      const alpha = clamp(strand.life / strand.max, 0, 1);
      const color = TONES[strand.tone] ?? TONES.touch;
      ctx.strokeStyle = `rgba(${color}, ${alpha * 0.85})`;
      ctx.shadowColor = `rgba(${color}, ${alpha})`;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.quadraticCurveTo((ox + ax) / 2, (oy + ay) / 2 + 14, ax, ay);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLinks(ctx) {
    ctx.save();
    for (const link of this.links) {
      if (!link.a.isConnected || !link.b.isConnected) continue;
      const ra = link.a.getBoundingClientRect();
      const rb = link.b.getBoundingClientRect();
      const ax = ra.left + ra.width / 2;
      const ay = ra.top + ra.height / 2;
      const bx = rb.left + rb.width / 2;
      const by = rb.top + rb.height / 2;
      const dist = Math.hypot(bx - ax, by - ay) || 1;
      const cx = (ax + bx) / 2 - ((by - ay) / dist) * dist * 0.14;
      const cy = (ay + by) / 2 + ((bx - ax) / dist) * dist * 0.14;
      const fade = clamp(link.life / 2, 0, 1);
      const color = TONES[link.tone] ?? TONES.link;
      ctx.strokeStyle = `rgba(${color}, ${0.75 * fade})`;
      ctx.shadowColor = `rgba(${color}, ${fade})`;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(cx, cy, bx, by);
      ctx.stroke();

      const t = (this.time * 0.35) % 1;
      const px = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx;
      const py = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * fade})`;
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawHighlights(ctx) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = 'square';
    const pad = 6;
    const arm = 10;
    for (const item of this.highlights) {
      if (!item.el.isConnected) continue;
      const rect = rectOf(item.el);
      if (rect.width === 0) continue;
      const alpha = clamp(item.life / item.max, 0, 1);
      const color = TONES[item.tone] ?? TONES.touch;
      const x0 = rect.left - pad;
      const y0 = rect.top - pad;
      const x1 = rect.left + rect.width + pad;
      const y1 = rect.top + rect.height + pad;
      ctx.strokeStyle = `rgba(${color}, ${alpha * 0.95})`;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + arm); ctx.lineTo(x0, y0); ctx.lineTo(x0 + arm, y0);
      ctx.moveTo(x1 - arm, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + arm);
      ctx.moveTo(x1, y1 - arm); ctx.lineTo(x1, y1); ctx.lineTo(x1 - arm, y1);
      ctx.moveTo(x0 + arm, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - arm);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLegs(ctx, sx, sy) {
    const f = this.axes();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const leg of this.legs) {
      const hip = this.hipPoint(leg, f);
      const foot = leg.foot;
      const dx = foot.x - hip.x;
      const dy = foot.y - hip.y;
      const dist = Math.hypot(dx, dy) || 1;
      const outwardX = f.rx * leg.def.side;
      const outwardY = f.ry * leg.def.side;
      const bulge = Math.max(0, REACH - dist) * 0.9 + 10 * SCALE;
      const [, j1, j2, j3] = leg.joints;
      j1.x = hip.x + dx * 0.33 + outwardX * bulge;
      j1.y = hip.y + dy * 0.33 + outwardY * bulge;
      j2.x = hip.x + dx * 0.72 + outwardX * bulge * 0.8;
      j2.y = hip.y + dy * 0.72 + outwardY * bulge * 0.8;
      j3.x = foot.x;
      j3.y = foot.y;
      solveFabrik(leg.joints, BONES, hip, foot);

      const lift = leg.swinging ? Math.sin(Math.PI * leg.t) : 0;
      const widths = [3.4, 2.5, 1.6].map((w) => w * 1.2 * (1 + lift * 0.3));
      for (const [color, extra] of [['rgba(224, 140, 195, 0.6)', 1.3], ['#0d0614', 0]]) {
        ctx.strokeStyle = color;
        for (let i = 0; i < BONES.length; i++) {
          const a = leg.joints[i];
          const b = leg.joints[i + 1];
          ctx.lineWidth = widths[i] + extra;
          ctx.beginPath();
          ctx.moveTo(a.x - sx, a.y - sy);
          ctx.lineTo(b.x - sx, b.y - sy);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  drawBody(ctx, sx, sy) {
    const breathe = 1 + Math.sin(this.time * 2.2) * 0.02;
    ctx.save();
    ctx.translate(this.pos.x - sx, this.pos.y - sy);
    ctx.rotate(this.heading);
    ctx.scale(breathe * SCALE, breathe * SCALE);

    const glow = ctx.createRadialGradient(0, 0, 4, 0, 0, 46);
    glow.addColorStop(0, 'rgba(224, 112, 176, 0.3)');
    glow.addColorStop(1, 'rgba(138, 107, 216, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 46, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0d0614';
    ctx.strokeStyle = 'rgba(232, 150, 200, 0.7)';
    ctx.lineWidth = 1.2;
    for (const [x, rx, ry] of [[-11, 14, 10.5], [6, 9, 7.5]]) {
      ctx.beginPath();
      ctx.ellipse(x, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 170, 110, 0.7)';
    ctx.beginPath();
    ctx.ellipse(-12, 0, 5, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(235, 240, 255, 0.9)';
    for (const y of [-2.6, 2.6]) {
      ctx.beginPath();
      ctx.arc(11, y, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
