import { createEvent } from '../spider/events.js';

const MAX_PENDING_CUES = 6;
const AMBIENT_CUES = new Set(['agent.observing', 'agent.target_selected']);

export function attachMotionBridge({ domainBus, cueBus, whenIdle, getState, extend }) {
  let pending = 0;

  function emit(type, fields) {
    const state = getState();
    if (AMBIENT_CUES.has(type) && pending >= MAX_PENDING_CUES) return;
    pending += 1;
    cueBus.emit(
      createEvent(type, {
        investigation: { id: state.investigationId ?? 'none', subject: state.input || 'demo', mode: 'simulated', kind: 'terminal' },
        ...fields,
      }),
    );
    whenIdle().then(() => { pending -= 1; });
  }

  const handlers = {
    'input.resolved': (event) => emit('agent.observing', { target: { id: 'terminal-query' }, message: event.payload.summary }),
    'entity.discovered': (event) => emit('agent.target_selected', { target: { id: `node:${event.payload.entityId}` }, message: event.payload.summary }),
    'relationship.discovered': (event) => emit('agent.finding_discovered', { target: { id: `edge:${event.payload.relationshipId}` }, message: event.payload.summary }),
    'graph.edge.selected': (event) => {
      const relationship = event.payload.relationship;
      if (!relationship) return;
      emit('agent.evidence_linked', {
        initiator: 'user',
        target: { id: `edge:${relationship.id}` },
        evidence: [{ id: relationship.id, kind: 'demo', label: relationship.id, source: 'Demonstration dataset', refs: [`node:${relationship.sourceEntityId}`, `node:${relationship.targetEntityId}`] }],
        message: 'Linked the two ends of the selected connection',
      });
    },
    'agent.blocked': (event) => emit('agent.action_failed', { target: { id: 'terminal-query' }, message: event.payload.summary }),
    'investigation.failed': (event) => emit('agent.action_failed', { target: { id: 'terminal-query' }, message: event.payload.summary }),
    'investigation.completed': (event) => emit('agent.investigation_completed', { message: event.payload.summary }),
  };

  const extra = extend?.(emit) ?? {};
  return domainBus.on('*', (event) => (handlers[event.type] ?? extra[event.type])?.(event));
}
