const EMPTY = Object.freeze({
  id: null,
  subject: '',
  mode: 'simulated',
  kind: 'terminal',
  status: 'idle',
  log: [],
  findings: [],
  links: [],
  failedTargets: [],
  linkedTargets: [],
  activeTarget: null,
  lastMessage: '',
});

export function createInvestigationStore(bus) {
  let state = EMPTY;
  const subscribers = new Set();

  function reduce(event) {
    const { investigation } = event;
    const base = investigation.id === state.id ? state : { ...EMPTY, ...investigation, status: 'running' };
    const targetId = event.target?.id ?? null;
    const next = {
      ...base,
      subject: investigation.subject,
      lastMessage: event.message || base.lastMessage,
      activeTarget: targetId ?? base.activeTarget,
      log: [...base.log, { ts: event.ts, type: event.type, message: event.message, targetId }],
    };

    if (event.type === 'agent.action_failed' && targetId) {
      next.failedTargets = [...base.failedTargets, targetId];
    }
    if (event.type === 'agent.finding_discovered') {
      next.findings = [
        ...base.findings,
        ...event.evidence.map((item) => ({ ...item, targetId, demo: investigation.mode === 'simulated' })),
      ];
    }
    if (event.type === 'agent.evidence_linked') {
      const refs = event.evidence.flatMap((item) => item.refs);
      next.links = [...base.links, ...event.evidence];
      next.linkedTargets = [...new Set([...base.linkedTargets, ...refs])];
    }
    if (event.type === 'agent.investigation_completed') {
      next.status = 'completed';
      next.activeTarget = null;
    }
    return next;
  }

  bus.on('*', (event) => {
    state = reduce(event);
    for (const subscriber of subscribers) subscriber(state);
  });

  return {
    get state() {
      return state;
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      subscriber(state);
      return () => subscribers.delete(subscriber);
    },
  };
}
