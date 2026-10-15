import { createEventBus, DOMAIN_EVENT_TYPES } from './js/spider/events.js';
import { Spider } from './js/spider/spider.js';
import { createChoreography } from './js/spider/choreography.js';
import { rectOf } from './js/spider/geometry.js';
import { createInvestigationStore } from './js/investigation.js';
import { runLandingTour } from './js/simulation.js';
import { createRouter } from './js/router.js';
import { BACKGROUND, mountBackground, setBackgroundActive } from './js/background.js';
import { createPreferences } from './js/preferences.js';
import { createController } from './js/investigation/controller.js';
import { attachMotionBridge } from './js/investigation/motion-bridge.js';
import { createRecents } from './js/investigation/recents.js';
import { mountWorkspace } from './js/workspace/workspace.js';
import { TerrainLight } from './js/terrain/terrain.js';
import { createMarket } from './js/market/market.js';
import { createMarketView } from './js/market/market-view.js';
import { marketCues } from './js/market/market-cues.js';
import { setupReveals, setupScrollFx, setupStoryGraph } from './js/motion.js';

const MOBILE_BREAKPOINT = 720;
const reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const reducedMotion = reducedQuery.matches;
reducedQuery.addEventListener('change', () => window.location.reload());

const bus = createEventBus();
const store = createInvestigationStore(bus);
const spider = new Spider(document.querySelector('#spider-canvas'), { reducedMotion });
const choreography = createChoreography({ spider, bus, reducedMotion });
const preferences = createPreferences({ reducedMotion });
const recents = createRecents();
const domainBus = createEventBus(DOMAIN_EVENT_TYPES);
const controller = createController({ bus: domainBus, delay: reducedMotion ? 0 : 140 });
const market = createMarket({ bus: domainBus });
let marketView = null;
attachMotionBridge({ domainBus, cueBus: bus, whenIdle: choreography.whenIdle, getState: () => controller.state, extend: marketCues(() => market) });

const spiderCanvas = document.querySelector('#spider-canvas');

spider.avoid = () => {
  if (router.current !== 'landing') return null;
  const title = document.querySelector('#hero-title');
  const rect = rectOf(title);
  if (rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
  return {
    left: rect.left + window.scrollX, right: rect.right + window.scrollX,
    top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY,
  };
};

document.querySelector('#skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  const main = document.querySelector('main:not([hidden])');
  main.setAttribute('tabindex', '-1');
  main.focus();
});
let yieldTimer = 0;

function updateSpiderClip() {
  if (router.current !== 'terminal') {
    spiderCanvas.style.clipPath = '';
    return;
  }
  const rect = document.querySelector('.ws-center').getBoundingClientRect();
  spiderCanvas.style.clipPath = `inset(${rect.top}px ${window.innerWidth - rect.right}px ${window.innerHeight - rect.bottom}px ${rect.left}px)`;
}

function syncSpiderMode() {
  choreography.setCalm(router.current === 'terminal' && preferences.calm);
}

function applyRoute(route) {
  const workspace = route === 'terminal';
  choreography.setSurface(workspace ? 'workspace' : 'landing');
  syncSpiderMode();
  setBackgroundActive(!workspace);
  updateSpiderClip();
  marketView?.setRouteActive(workspace);
  if (workspace) {
    document.querySelector('#terminal').focus({ preventScroll: true });
    spider.rebase();
  }
}

const router = createRouter({ onChange: applyRoute });

function setupWorkspace() {
  let workspace = null;
  marketView = createMarketView({
    market,
    reducedMotion,
    onViewChange: (view) => {
      if (view === 'network') workspace?.render();
      updateSpiderClip();
    },
    onLayoutChange: updateSpiderClip,
  });
  workspace = mountWorkspace({ controller, preferences, recents, onLayoutChange: updateSpiderClip, intake: marketView.intake });
  let recorded = null;
  controller.subscribe((state) => {
    if (state.status === 'ready' && state.investigationId !== recorded) {
      recorded = state.investigationId;
      recents.add(state.input);
      workspace.refreshRecents();
    }
  });
  preferences.subscribe(syncSpiderMode);
  window.addEventListener('resize', updateSpiderClip);
  const center = document.querySelector('.ws-center');
  new ResizeObserver(updateSpiderClip).observe(center);
  for (const type of ['pointerdown', 'wheel', 'keydown']) {
    center.addEventListener(type, () => {
      spiderCanvas.classList.add('yield');
      clearTimeout(yieldTimer);
      yieldTimer = setTimeout(() => spiderCanvas.classList.remove('yield'), 4000);
    }, { passive: true });
  }
}

function setupMenu() {
  const burger = document.querySelector('.burger');
  const overlay = document.querySelector('.overlay');
  const menu = document.querySelector('.mobile-menu');

  function setOpen(open) {
    burger.setAttribute('aria-expanded', String(open));
    overlay.hidden = !open;
    menu.hidden = !open;
    document.body.classList.toggle('menu-open', open);
  }

  burger.addEventListener('click', () => setOpen(burger.getAttribute('aria-expanded') !== 'true'));
  overlay.addEventListener('click', () => setOpen(false));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > MOBILE_BREAKPOINT) setOpen(false);
  });
}

function setupTourStatus() {
  const message = document.querySelector('.tour-message');
  store.subscribe((state) => {
    if (state.kind === 'tour' && state.lastMessage) message.textContent = state.lastMessage;
  });
}

let activeRun = null;

function stopActiveRun() {
  activeRun?.abort();
}

function setupTour() {
  const button = document.querySelector('[data-watch-tour]');
  button.addEventListener('click', async () => {
    if (activeRun) return;
    activeRun = new AbortController();
    button.disabled = true;
    try {
      await runLandingTour({ bus, pace: choreography.whenIdle, signal: activeRun.signal });
    } finally {
      activeRun = null;
      button.disabled = false;
    }
  });
}

function setupStartLinks() {
  for (const link of document.querySelectorAll('[data-start-investigation]')) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      stopActiveRun();
      choreography.leadTransition(link, () => router.navigate('terminal'));
    });
  }
}

const STEP_NODES = ['g-subject', 'g-market', 'g-transactions', 'g-evidence', 'g-evidence'];

function setupMotion() {
  setupReveals({ reducedMotion });
  setupScrollFx({ reducedMotion });
  setupStoryGraph({
    reducedMotion,
    onStep(step) {
      if (router.current !== 'landing' || activeRun) return;
      const node = document.querySelector(`[data-spider-id="${STEP_NODES[step - 1]}"]`);
      choreography.visit(node);
    },
  });
}

function boot() {
  mountBackground({ reducedMotion });
  setupMotion();
  setupMenu();
  setupTourStatus();
  setupTour();
  setupStartLinks();
  setupWorkspace();

  const route = router.init();
  spider.start();
  choreography.start({ withIntro: route === 'landing' });
  if (route === 'terminal') spider.placeAtScreen(-70, window.innerHeight * 0.3, 0.1);
  applyRoute(route);

  const terrainCanvas = document.querySelector('#terrain-canvas');
  let terrain = null;
  if (BACKGROUND.enabled && BACKGROUND.terrain) {
    terrain = new TerrainLight(terrainCanvas, { reducedMotion });
    terrain.start();
    terrain.attach(spider);
  } else {
    terrainCanvas.remove();
  }

  const terrainTouch = spider.onTouch;
  const terrainLink = spider.onLink;
  spider.onTouch = (info) => {
    terrainTouch?.(info);
    marketView.light.onTouch(info);
  };
  spider.onLink = (a, b) => {
    terrainLink?.(a, b);
    marketView.light.onLink(a, b);
  };

  window.OpenCrawl = { bus, domainBus, controller, market, marketView, store, spider, terrain, dispatch: bus.emit };
}

boot();
