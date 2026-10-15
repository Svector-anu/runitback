export function setupReveals({ reducedMotion }) {
  const items = document.querySelectorAll('[data-reveal]');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.2, rootMargin: '0px 0px -8% 0px' }
  );
  items.forEach((el) => observer.observe(el));
}

export function setupScrollFx({ reducedMotion }) {
  if (reducedMotion) return () => {};
  const bg = document.querySelector('.bg');
  let ticking = false;

  function apply() {
    ticking = false;
    const y = window.scrollY;
    const dim = Math.min(0.45, y / (window.innerHeight * 2.2));
    bg.style.setProperty('--dim', dim.toFixed(3));
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(apply);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  apply();
  return () => window.removeEventListener('scroll', onScroll);
}

export function setupStoryGraph({ reducedMotion, onStep }) {
  const graph = document.querySelector('.story-graph');
  const steps = [...document.querySelectorAll('.step')];
  if (!graph || steps.length === 0) return;

  function setStep(step) {
    graph.dataset.step = String(step);
    graph.querySelectorAll('[data-from]').forEach((el) => {
      el.classList.toggle('is-on', Number(el.dataset.from) <= step);
    });
    steps.forEach((el, index) => el.classList.toggle('is-active', index + 1 === step));
  }

  if (reducedMotion || !('IntersectionObserver' in window)) {
    setStep(steps.length);
    return;
  }

  setStep(0);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const step = steps.indexOf(entry.target) + 1;
        setStep(step);
        onStep?.(step);
      }
    },
    { rootMargin: '-42% 0px -42% 0px' }
  );
  steps.forEach((el) => observer.observe(el));
}
