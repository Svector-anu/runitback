export const ENTITY_KINDS = Object.freeze([
  'wallet', 'token', 'transaction', 'contract', 'protocol', 'equity', 'market_event', 'web_page', 'organization', 'note',
]);

export const RELATION_TYPES = Object.freeze([
  'transfer', 'swap', 'holds', 'interacts_with', 'same_source_mention', 'temporal_correlation', 'associated_with',
]);

export const RELATION_STATUSES = Object.freeze(['direct', 'provider_labeled', 'derived', 'hypothesis', 'demo']);

export const KIND_LABEL = Object.freeze({
  wallet: 'Wallet', token: 'Token', transaction: 'Transaction', contract: 'Contract', protocol: 'Protocol',
  equity: 'Equity', market_event: 'Market event', web_page: 'Web page', organization: 'Organization', note: 'Note',
});

export const TYPE_LABEL = Object.freeze({
  transfer: 'Transfer', swap: 'Swap', holds: 'Holds', interacts_with: 'Interacts with',
  same_source_mention: 'Same-source mention', temporal_correlation: 'Temporal correlation', associated_with: 'Associated with',
});

export const STATUS_LABEL = Object.freeze({
  direct: 'Direct observation', provider_labeled: 'Provider-labeled', derived: 'Derived', hypothesis: 'Hypothesis', demo: 'Demo',
});

export const FORM_LABEL = Object.freeze({ raw: 'raw', normalized: 'normalized', derived: 'derived', inferred: 'inferred' });

export const idOf = (namespace, kind, value) => `${namespace}:${kind}:${value}`;

export function parseId(id) {
  const [namespace, kind, ...rest] = id.split(':');
  return { namespace, kind, value: rest.join(':') };
}
