import { CANCELLED } from './spider.js';
import { docPointAt, ensureVisible, makeAnchor, pickTarget, resolveTarget } from './targets.js';

const CURIOUS_COOLDOWN = 3500;
const CURIOUS_RANGE = 520;
const FLEE_RANGE = 200;
const INTRO_DELAY = 1300;
const VISIT_COOLDOWN = 900;

const toDocPoint = (event) => ({ x: event.clientX + window.scrollX, y: event.clientY + window.scrollY });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const random = (min, max) => min + Math.random() * (max - min);

export function createChoreography({ spider, bus, reducedMotion }) {
  let run = 0;
  let mode = 'ambient';
  let queue = Promise.resolve();
  let lastCuriosity = 0;
  let pointer = null;
  let lastTarget = null;
  let lastVisit = 0;
  let surface = 'landing';
  let calm = false;
  const timers = new Set();
  const cleanups = [];

  function sleep(ms) {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        timers.delete(id);
        resolve();
      }, reducedMotion ? Math.min(ms, 250) : ms);
      timers.add(id);
    });
  }

  function begin(plan) {
    const id = ++run;
    spider.cancelGoal();
    const alive = () => id === run;
    plan(alive).catch((error) => {
      if (error !== CANCELLED) console.error(error);
    });
  }

  async function walkToElement(el, alive, options) {
    const anchor = makeAnchor();
    await spider.walkTo(() => (el.isConnected ? docPointAt(el, anchor) : null), options);
    return alive();
  }

  async function ambient(alive) {
    if (surface === 'workspace' || calm) {
      mode = 'parked';
      return;
    }
    mode = 'ambient';
    while (alive()) {
      const el = pickTarget(lastTarget);
      if (!el) {
        await sleep(900);
        continue;
      }
      lastTarget = el;
      if (!(await walkToElement(el, alive))) return;
      spider.touch(el);
      await sleep(random(800, 2000));
    }
  }

  async function intro(alive) {
    const hero = document.querySelector('#hero-title');
    const cta = document.querySelector('.hero-actions .cta');
    const entryY = window.innerHeight * 0.32;
    spider.placeAtScreen(-70, entryY, 0.1);
    await sleep(reducedMotion ? 0 : INTRO_DELAY);
    if (!alive()) return;
    if (hero) {
      if (!(await walkToElement(hero, alive, { speed: 0.9 }))) return;
      spider.touch(hero, { strands: 4 });
      if (!reducedMotion) {
        hero.classList.add('is-tearing');
        sleep(600).then(() => hero.classList.remove('is-tearing'));
      }
      await sleep(1300);
      if (!alive()) return;
    }
    if (cta) {
      if (!(await walkToElement(cta, alive, { speed: 0.8 }))) return;
      spider.touch(cta, { tone: 'select', scan: true });
      await sleep(1100);
    }
    await ambient(alive);
  }

  async function curious(alive) {
    mode = 'curious';
    const hold = sleep(random(1600, 2400));
    const follow = spider
      .walkTo(
        () => {
          if (!pointer) return null;
          const from = spider.pos;
          const dx = from.x - pointer.x;
          const dy = from.y - pointer.y;
          const dist = Math.hypot(dx, dy) || 1;
          return { x: pointer.x + (dx / dist) * 80, y: pointer.y + (dy / dist) * 80 };
        },
        { stopDistance: 14, speed: 0.9 }
      )
      .catch(() => {});
    await Promise.race([hold, follow]);
    if (!alive()) return;
    await ambient(alive);
  }

  async function startled(from, alive) {
    mode = 'startled';
    await spider.flee(from);
    if (!alive()) return;
    await sleep(500);
    await ambient(alive);
  }

  async function visitPlan(el, alive) {
    mode = 'visiting';
    if (!(await walkToElement(el, alive, { speed: 2.2 }))) return;
    spider.touch(el, { tone: 'select', strands: 3, scan: true });
    await sleep(1400);
    await ambient(alive);
  }

  function visit(el) {
    if (reducedMotion || !el?.isConnected) return;
    if (mode === 'agent' || mode === 'transition') return;
    const now = performance.now();
    if (now - lastVisit < VISIT_COOLDOWN) return;
    lastVisit = now;
    begin((alive) => visitPlan(el, alive));
  }

  function onPointerMove(event) {
    pointer = toDocPoint(event);
    if (mode !== 'ambient' || reducedMotion || surface === 'workspace' || calm) return;
    const now = performance.now();
    if (now - lastCuriosity < CURIOUS_COOLDOWN) return;
    if (distance(spider.pos, pointer) > CURIOUS_RANGE) return;
    if (Math.random() > 0.35) return;
    lastCuriosity = now;
    begin(curious);
  }

  function onPointerDown(event) {
    if (mode === 'agent' || mode === 'transition' || reducedMotion || surface === 'workspace' || calm) return;
    const point = toDocPoint(event);
    if (distance(spider.pos, point) > FLEE_RANGE) return;
    begin((alive) => startled(point, alive));
  }

  async function handleAgentEvent(event) {
    const el = resolveTarget(event.target);
    if (!el || el.hidden) return;
    if (calm) {
      spider.flash(el, 'select');
      return;
    }
    if (event.initiator === 'user' && ensureVisible(el, { instant: reducedMotion })) await sleep(650);

    const approach = async (options) => walkToElement(el, () => true, options).catch(() => {});

    switch (event.type) {
      case 'agent.observing':
      case 'agent.navigating':
        await approach({ speed: 1.2 });
        spider.touch(el, { strands: 2 });
        break;
      case 'agent.target_selected':
        await approach({ speed: 1.2 });
        spider.touch(el, { tone: 'select', scan: true });
        break;
      case 'agent.action_started':
        await approach({ speed: 1.2 });
        spider.flash(el, 'select');
        await sleep(350);
        break;
      case 'agent.action_completed':
        await approach({ speed: 1.2 });
        spider.touch(el, { strands: 3 });
        break;
      case 'agent.finding_discovered':
        await approach({ speed: 1.2 });
        spider.touch(el, { tone: 'finding', strands: 4, scan: true });
        await sleep(300);
        break;
      case 'agent.evidence_linked': {
        const [from, to] = event.evidence.flatMap((item) => item.refs).map((id) => resolveTarget({ id }));
        if (from && to && !from.hidden && !to.hidden) spider.link(from, to);
        await sleep(300);
        break;
      }
      case 'agent.action_failed':
        await approach({ speed: 1.2 });
        spider.touch(el, { tone: 'fail', strands: 2 });
        await sleep(450);
        break;
      case 'agent.investigation_completed':
        break;
      default:
        break;
    }
  }

  function enterAgentMode() {
    if (mode === 'agent') return;
    mode = 'agent';
    run++;
    spider.cancelGoal();
  }

  const offAgent = bus.on('*', (event) => {
    enterAgentMode();
    queue = queue
      .then(() => handleAgentEvent(event))
      .then(() => {
        if (event.type === 'agent.investigation_completed') return sleep(700).then(() => begin(ambient));
        return undefined;
      })
      .catch((error) => {
        if (error !== CANCELLED) console.error(error);
      });
  });

  async function leadTransition(trigger, navigate) {
    mode = 'transition';
    const id = ++run;
    spider.cancelGoal();
    const landing = document.querySelector('#landing');
    let finished = false;
    let skipped = false;

    const finish = () => {
      if (finished) return false;
      finished = true;
      document.removeEventListener('keydown', skip);
      document.removeEventListener('pointerdown', skip);
      landing?.classList.remove('is-leaving');
      navigate();
      spider.rebase();
      return true;
    };
    function skip() {
      skipped = true;
      spider.cancelGoal();
      finish();
    }
    document.addEventListener('keydown', skip, { once: true });
    document.addEventListener('pointerdown', skip, { once: true });
    const live = () => !skipped && id === run;

    if (trigger && !reducedMotion) {
      if (ensureVisible(trigger)) await sleep(600);
      if (!live()) return settle(id);
      await limited(walkToElement(trigger, () => true, { speed: 3 }).catch(() => {}), 1800);
      if (!live()) return settle(id);
      spider.touch(trigger, { tone: 'select', strands: 4, scan: true });
      landing?.classList.add('is-leaving');
      await sleep(450);
      if (!live()) return settle(id);
      const center = () => ({ x: window.scrollX + window.innerWidth / 2, y: window.scrollY + window.innerHeight * 0.45 });
      await limited(spider.walkTo(center, { speed: 3, stopDistance: 20 }).catch(() => {}), 1200);
    }
    finish();
    await settle(id);
  }

  async function limited(promise, ms) {
    await Promise.race([promise, sleep(ms)]);
    spider.cancelGoal();
  }

  async function settle(id) {
    if (id !== run) return;
    await sleep(120);
    const query = document.querySelector('[data-spider-id="terminal-query"]');
    if (query && !reducedMotion && id === run) {
      await walkToElement(query, () => true, { speed: 1.4 }).catch(() => {});
      if (id === run) spider.touch(query, { tone: 'select' });
    }
    await sleep(900);
    if (id === run) begin(ambient);
  }

  function start({ withIntro = true } = {}) {
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    cleanups.push(
      () => document.removeEventListener('pointermove', onPointerMove),
      () => document.removeEventListener('pointerdown', onPointerDown)
    );
    if (withIntro) begin(intro);
    else begin(ambient);
  }

  function destroy() {
    run++;
    offAgent();
    cleanups.forEach((fn) => fn());
    timers.forEach(clearTimeout);
    timers.clear();
  }

  return {
    start,
    destroy,
    leadTransition,
    resumeAmbient: () => begin(ambient),
    setSurface(next) {
      if (next === surface) return;
      surface = next;
      begin(ambient);
    },
    setCalm(next) {
      if (next === calm) return;
      calm = next;
      spider.setHidden(next);
      begin(ambient);
    },
    visit,
    whenIdle: () => queue.then(() => spider.whenSettled()),
  };
}
