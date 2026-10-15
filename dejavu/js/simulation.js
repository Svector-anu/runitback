import { createEvent } from './spider/events.js';

let counter = 0;

function makeEmitter({ bus, subject, kind, initiator, pace, signal }) {
  const investigation = { id: `sim-${Date.now()}-${++counter}`, subject, mode: 'simulated', kind };

  return async function step(type, { target, action, evidence, message }) {
    if (signal.aborted) return false;
    bus.emit(
      createEvent(type, {
        investigation,
        initiator,
        target: target ? { id: target.id, label: target.label } : null,
        action: action ?? null,
        evidence: evidence ?? [],
        message,
      })
    );
    await pace();
    return !signal.aborted;
  };
}

function finish(step, signal, completedMessage) {
  return step('agent.investigation_completed', {
    message: signal.aborted ? 'Simulated run stopped.' : completedMessage,
  });
}

export async function runLandingTour({ bus, pace, signal }) {
  const step = makeEmitter({ bus, subject: 'Guided tour', kind: 'tour', initiator: 'user', pace, signal });
  const stepTarget = (n, label) => ({ id: `step-${n}`, label });
  const tourLink = (n) => [{ id: `t-${n}`, kind: 'demo', label: `Step ${n} to step ${n + 1}`, source: 'Guided tour', refs: [`step-${n}`, `step-${n + 1}`] }];

  const script = [
    ['agent.observing', { target: { id: 'hero-title', label: 'Headline' }, message: 'Reading the headline' }],
    ['agent.navigating', { target: stepTarget(1, 'Start with a subject'), message: 'Step 1: start with a subject' }],
    ['agent.action_completed', { target: stepTarget(1), message: 'A ticker, token address or wallet goes in first' }],
    ['agent.navigating', { target: stepTarget(2, 'Investigate'), message: 'Step 2: investigate the activity' }],
    ['agent.evidence_linked', { target: stepTarget(2), evidence: tourLink(1), message: 'Steps 1 and 2 are linked' }],
    ['agent.navigating', { target: stepTarget(3, 'Watch'), message: 'Step 3: every action shows on the page' }],
    ['agent.evidence_linked', { target: stepTarget(3), evidence: tourLink(2), message: 'Steps 2 and 3 are linked' }],
    ['agent.navigating', { target: stepTarget(4, 'Inspect'), message: 'Step 4: each connection points back to its source' }],
    ['agent.evidence_linked', { target: stepTarget(4), evidence: tourLink(3), message: 'Steps 3 and 4 are linked' }],
    ['agent.navigating', { target: stepTarget(5, 'Terminal'), message: 'Step 5: open the terminal' }],
    ['agent.evidence_linked', { target: stepTarget(5), evidence: tourLink(4), message: 'Steps 4 and 5 are linked' }],
  ];

  for (const [type, fields] of script) if (!(await step(type, fields))) break;
  await finish(step, signal, 'Tour finished. Nothing above was real market data.');
}
