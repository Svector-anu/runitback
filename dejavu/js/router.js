const TERMINAL_HASH = '#/investigate';

export function createRouter({ onChange }) {
  const views = {
    landing: document.querySelector('#landing'),
    terminal: document.querySelector('#terminal'),
  };
  let current = null;

  function routeFromHash() {
    return window.location.hash.startsWith(TERMINAL_HASH) ? 'terminal' : 'landing';
  }

  function render(route, { silent = false } = {}) {
    if (route === current) return;
    current = route;
    for (const [name, el] of Object.entries(views)) el.hidden = name !== route;
    document.body.dataset.view = route;
    for (const link of document.querySelectorAll('[data-route]')) {
      if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (route === 'terminal') window.scrollTo(0, 0);
    if (!silent) onChange(route);
  }

  function onHashChange() {
    render(routeFromHash());
  }

  window.addEventListener('hashchange', onHashChange);

  return {
    get current() {
      return current;
    },
    init() {
      render(routeFromHash(), { silent: true });
      return current;
    },
    navigate(route) {
      const hash = route === 'terminal' ? TERMINAL_HASH : '#top';
      history.pushState(null, '', hash);
      render(route);
    },
    destroy() {
      window.removeEventListener('hashchange', onHashChange);
    },
  };
}
