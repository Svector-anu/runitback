export const initialState = Object.freeze({
  investigationId: null,
  status: 'empty',
  run: 'idle',
  origin: 'demo',
  input: '',
  rootId: null,
  entityIds: [],
  relationshipIds: [],
  selection: null,
  banner: null,
  notice: null,
  candidates: [],
  log: [],
});

function appendLog(state, event, fields = {}) {
  const summary = event.payload.summary;
  if (!summary) return state.log;
  return [...state.log, { id: event.id, ts: event.ts, type: event.type, summary, ...fields }];
}

export function reduce(state, event) {
  const { payload } = event;
  switch (event.type) {
    case 'investigation.started':
      return {
        ...initialState,
        investigationId: event.investigationId,
        status: 'resolving',
        run: 'resolving',
        origin: event.origin,
        input: payload.input ?? '',
        log: appendLog(initialState, event),
      };
    case 'investigation.reset':
      return { ...initialState };
    case 'input.resolved':
      return { ...state, status: 'loading', run: 'tracing', rootId: payload.rootId, log: appendLog(state, event, { entityId: payload.rootId }) };
    case 'input.unsupported':
      return { ...state, status: 'unsupported', run: 'idle', notice: { text: payload.summary }, log: appendLog(state, event) };
    case 'agent.needs_input':
      return { ...state, status: 'needs_input', run: 'needs_input', candidates: payload.candidates, notice: { text: payload.summary }, log: appendLog(state, event) };
    case 'entity.discovered':
      if (state.entityIds.includes(payload.entityId)) return state;
      return { ...state, entityIds: [...state.entityIds, payload.entityId], log: appendLog(state, event, { entityId: payload.entityId }) };
    case 'relationship.discovered':
      if (state.relationshipIds.includes(payload.relationshipId)) return state;
      return {
        ...state,
        relationshipIds: [...state.relationshipIds, payload.relationshipId],
        log: appendLog(state, event, { relationshipId: payload.relationshipId }),
      };
    case 'graph.neighborhood.expanded':
      return {
        ...state,
        banner: payload.hiddenCount > 0
          ? { kind: 'partial', text: `Showing ${payload.shownCount} of ${payload.totalCount} connections for ${payload.display}.`, entityId: payload.entityId }
          : state.banner?.entityId === payload.entityId ? null : state.banner,
        log: appendLog(state, event, { entityId: payload.entityId }),
      };
    case 'graph.node.selected':
      return { ...state, selection: { kind: 'entity', id: payload.entityId } };
    case 'graph.edge.selected':
      return { ...state, selection: { kind: 'relationship', id: payload.relationshipId } };
    case 'graph.selection.cleared':
      return { ...state, selection: null };
    case 'investigation.completed':
      return { ...state, status: 'ready', run: 'completed', log: appendLog(state, event) };
    case 'investigation.failed':
    case 'agent.blocked':
      return { ...state, status: 'error', run: 'idle', banner: { kind: 'error', text: payload.summary }, log: appendLog(state, event) };
    default:
      return { ...state, log: appendLog(state, event) };
  }
}
