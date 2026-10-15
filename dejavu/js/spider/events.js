/**
 * Agent event contract. Every event carries the same envelope:
 *
 * {
 *   type:          one of EVENT_TYPES
 *   ts:            ms since epoch
 *   initiator:     "user" | "agent"   (only "user" events may scroll the page)
 *   investigation: { id, subject, mode: "simulated" | "live", kind: "terminal" | "tour" }
 *   target:        { id?, selector?, label? } | null   (id matches [data-spider-id])
 *   action:        { kind: "read" | "navigate" | "click" | "type" | "scroll", detail? } | null
 *   evidence:      [{ id, kind, label, source, refs: [targetId, targetId] }]
 *   message:       short human-readable line shown in the activity log
 * }
 */
export const EVENT_TYPES = Object.freeze([
  'agent.observing',
  'agent.navigating',
  'agent.target_selected',
  'agent.action_started',
  'agent.action_completed',
  'agent.finding_discovered',
  'agent.evidence_linked',
  'agent.action_failed',
  'agent.investigation_completed',
]);

export function createEvent(type, fields) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown agent event type: ${type}`);
  return {
    type,
    ts: Date.now(),
    initiator: 'agent',
    target: null,
    action: null,
    evidence: [],
    message: '',
    ...fields,
  };
}

export const DOMAIN_EVENT_TYPES = Object.freeze([
  'investigation.started',
  'investigation.reset',
  'input.resolved',
  'input.unsupported',
  'source.requested',
  'source.observed',
  'entity.discovered',
  'relationship.discovered',
  'relationship.verified',
  'relationship.disputed',
  'graph.node.selected',
  'graph.edge.selected',
  'graph.selection.cleared',
  'graph.neighborhood.expanded',
  'agent.needs_input',
  'agent.blocked',
  'investigation.completed',
  'investigation.failed',
  'market.opened',
  'market.loaded',
  'market.history_loaded',
  'market.event_detected',
  'market.point_selected',
  'market.event_selected',
  'market.failed',
]);

let domainCounter = 0;

/** Domain event envelope: { id, type, ts, investigationId, origin: "demo" | "live", payload } */
export function createDomainEvent(type, { investigationId, origin = 'demo', payload = {} }) {
  if (!DOMAIN_EVENT_TYPES.includes(type)) throw new Error(`Unknown domain event type: ${type}`);
  return { id: `ev-${++domainCounter}`, type, ts: Date.now(), investigationId, origin, payload };
}

export function createEventBus(allowedTypes = EVENT_TYPES) {
  const listeners = new Map();

  function on(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
    return () => listeners.get(type)?.delete(listener);
  }

  function emit(event) {
    if (!allowedTypes.includes(event?.type)) {
      console.warn('Ignoring event with unknown type', event);
      return;
    }
    for (const key of [event.type, '*']) {
      for (const listener of listeners.get(key) ?? []) {
        try {
          listener(event);
        } catch (error) {
          console.error(`Listener for ${key} failed`, error);
        }
      }
    }
  }

  return { on, emit };
}
