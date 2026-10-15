import { markerId } from './chart.js';

const SELECTION_SETTLE_MS = 450;

/**
 * Turns market domain events into spider cues. Every target id is derived from a real candle time, so the spider
 * can only be sent to a data point that exists on the chart. Data renders immediately; cues only decorate it.
 */
export function marketCues(getMarket) {
  return (emit) => {
    const investigation = () => {
      const { symbol } = getMarket().state;
      return { id: `market:${symbol}`, subject: symbol ?? 'market', mode: 'live', kind: 'terminal' };
    };
    let selectionTimer = 0;

    return {
      'market.opened': (event) => emit('agent.observing', { investigation: investigation(), target: { id: 'market-head' }, message: event.payload.summary }),
      'market.loaded': (event) => emit('agent.observing', { investigation: investigation(), target: { id: markerId(event.payload.t) }, message: 'Reading the latest bar' }),
      'market.event_detected': (event) => emit('agent.finding_discovered', {
        investigation: investigation(), target: { id: markerId(event.payload.t) }, message: event.payload.summary,
      }),
      'market.point_selected': (event) => {
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => emit('agent.target_selected', {
          initiator: 'user', investigation: investigation(), target: { id: markerId(event.payload.t) }, message: 'Pointing at the selected bar',
        }), SELECTION_SETTLE_MS);
      },
      'market.event_selected': (event) => {
        clearTimeout(selectionTimer);
        const { t, referenceT } = event.payload;
        emit('agent.target_selected', {
          initiator: 'user', investigation: investigation(), target: { id: markerId(t) }, message: event.payload.summary,
        });
        if (referenceT != null) {
          emit('agent.evidence_linked', {
            initiator: 'user', investigation: investigation(), target: { id: markerId(t) },
            evidence: [{ id: event.payload.eventId, kind: 'derived', label: event.payload.summary, source: 'Derived from provider candles', refs: [markerId(referenceT), markerId(t)] }],
            message: 'Linked this bar to the bar that set the level',
          });
        }
      },
      'market.failed': (event) => emit('agent.action_failed', { investigation: investigation(), target: { id: 'market-status' }, message: event.payload.summary }),
    };
  };
}
