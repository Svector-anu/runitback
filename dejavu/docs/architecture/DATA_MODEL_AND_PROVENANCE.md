# Data Model and Provenance

Status: **proposed**. Nothing here exists in code. The only data today is the simulated evidence object in `js/simulation.js`: `{ id, kind: "demo", label, source: "Simulated run, not sourced", refs: [targetId, targetId] }`, whose `refs` are DOM target ids, not entity ids. The model below replaces that. Final fields follow actual provider capability; fields appear only when supported.

## Principles

1. Provider-neutral canonical model; adapters normalize into it (TECHNICAL_ARCHITECTURE).
2. Stable, namespaced IDs.
3. Every material observation has provenance.
4. Demo and live are different values of one field, never inferred (DEC-005).
5. No decorative confidence or risk scores (DEC-013).
6. Missing data is a state (`unavailable`), not zero or empty.

## Identifiers

`{namespace}:{kind}:{value}`, lowercase kind, canonical value per chain or source.

| Example | Meaning |
|---|---|
| `demo:wallet:w-0007` | fictional wallet in the seeded dataset |
| `eth:address:0xabc...` | later, live Ethereum address (checksummed form stored in `display`) |
| `eth:tx:0x...` | transaction |
| `web:page:https://...` | normalized URL |
| `mkt:equity:NASDAQ:NVDA` | listed equity |

Demo identifiers must be visibly fictional (`demo:` namespace, short synthetic values) so they cannot be mistaken for real addresses.

## Entity

```
Entity {
  id            : string                  // canonical id
  kind          : "wallet" | "token" | "transaction" | "contract" | "protocol"
                | "equity" | "market_event" | "web_page" | "organization" | "note"
  display       : string                  // short human name or truncated identifier
  identifiers   : { type: string, value: string }[]   // address, hash, ticker, url
  origin        : "demo" | "live"
  firstSeen?    : ISO8601
  lastSeen?     : ISO8601
  attributes    : Record<string, Attribute>  // each Attribute carries its own provenanceIds
  provenanceIds : string[]
  freshness     : "fresh" | "stale" | "unavailable"
}
Attribute { value, unit?, observedAt, status: "raw"|"normalized"|"derived"|"inferred", provenanceIds[] }
```

Out of the first slice: `market_event`, `organization`, `note`, `contract` and `protocol` details, `equity`. Slice 1 uses `wallet`, `token`, `transaction`, `web_page` (as a demo source).

## Relationship

```
Relationship {
  id, sourceEntityId, targetEntityId,
  type          : "transfer" | "swap" | "holds" | "interacts_with" | "same_source_mention"
                | "temporal_correlation" | "associated_with"
  direction     : "directed" | "undirected"
  status        : "direct" | "provider_labeled" | "derived" | "hypothesis" | "demo"
  origin        : "demo" | "live"
  observedAt, validFrom?, validTo?
  amount?, unit?, chainOrMarket?
  provenanceIds : string[]
  conflicts?    : ConflictRef[]
  confidence?   : only if a documented method exists (DEC-013)
}
```

Meaning of `status`:
- `direct`: observed in a primary record (for example a transaction on a chain).
- `provider_labeled`: asserted by a provider or label set; the provider is named.
- `derived`: computed from other observations by a documented method (method stored).
- `hypothesis`: proposed by a user or agent; never presented as fact.
- `demo`: from the seeded dataset.

`type` is deliberately small. Add types only when a provider supplies them.

## Provenance

```
Source {
  id, providerId, kind: "chain_record" | "provider_api" | "web_page" | "user_note" | "demo_dataset"
  title, url?, reference?   // tx hash + block, page URL, dataset version
  license?, limitations?    // truncation, delay, coverage
}
Observation {
  id, sourceId, entityIds[], relationshipIds[]
  retrievedAt, observedAt?
  form: "raw" | "normalized" | "derived" | "inferred"
  method?                   // required when derived or inferred
  chainOrMarket?
  payloadRef?               // pointer to raw record, never inline secrets
  status: "ok" | "partial" | "stale" | "failed"
  limitation?               // e.g. "showing 1000 of more"
}
```

UI contract: from any node, edge, or finding the user can open the supporting observation and source in one action. A claim without an observation is not shown as fact.

## Quality states

| State | Rule |
|---|---|
| Fresh / Stale | stale threshold per provider (to define); stale shows age and a refresh action |
| Partial | the controller records which sources failed or were capped; the canvas banner names them and any truncation ("showing N of M") |
| Conflicting | two observations disagree on the same attribute: store both with times and sources; show side by side; never pick silently |
| Unavailable | attribute absent: show "not available", not blank or 0 |
| Demo | `origin: "demo"`: persistent badge on entities, edges, findings, timeline items |

## Investigation

```
Investigation { id, title, createdAt, rootEntityId, scope: { sources[], chains[], timeRange }, filters, 
                graph: { entityIds[], relationshipIds[] }, events: DomainEvent[], origin }
```
In the first slice an investigation lives only in memory for the session (DEC-011).

## Domain events

Envelope `{ id, type, ts, investigationId, correlationId?, origin, payload }`. Types in TECHNICAL_ARCHITECTURE. Payload carries ids and short labels, never private reasoning or raw secrets.

## Demo dataset (slice 1)

Deterministic, versioned (`demo-v1`), small: one root wallet or token, about 12 to 18 entities, 20 to 30 relationships across 3 types, mixed statuses (a direct transfer, a provider-labeled association, a derived correlation, one conflict, one stale attribute, one unavailable attribute) so every UI state is exercisable. All sources are `demo_dataset`. It must never contain real addresses or tickers presented as data.

## Verified (definition, design review 2026-10-12, proposed)

"Verified" is a computed property of a relationship, never a stored status and never set by an agent or a provider label. A relationship is **verified** only if all of the following hold:

1. `origin` is `live`.
2. `status` is `direct`: it is observed in a primary record (for example a chain transaction), not merely labeled by a provider or derived.
3. At least one `Observation` with `form` `raw` or `normalized` from a source of kind `chain_record` (or another primary kind defined per vertical) supports it.
4. That source's `reference` resolves (for example transaction hash and block, or URL) and `retrievedAt` is within the freshness threshold for that source.
5. No unresolved conflict is attached to it.
6. Both endpoints exist in the graph with `origin: live`.

Consequences: `derived`, `provider_labeled`, `hypothesis`, and `demo` relationships can never be verified. A provider-labeled association is shown as "Reported by <provider>". The UI shows the **Verified** chip, the solid line style, and a solid terrain connection path only for verified relationships. The domain event `relationship.verified` is emitted only when the rule becomes true. If freshness lapses, the chip changes to Stale and the line style returns to its status style. Demo data therefore never shows Verified. A plain `Source` link from every claim to its reference is part of "verified".

## Visible evidence mapping (design review)

| What the user sees | Model field |
|---|---|
| node shape and icon | `Entity.kind` |
| node label | `Entity.display` |
| Demo chip | `Entity.origin` / `Relationship.origin` |
| edge style | `Relationship.status` (and `verification`) |
| arrowhead | `Relationship.direction` |
| edge label amount | `amount`, `unit` |
| Time row | `observedAt`, `validFrom`, `validTo` |
| Evidence list | `provenanceIds` -> `Observation` -> `Source` |
| Conflicts row | `Relationship.conflicts` |
| Confidence row | `confidence`, absent unless a documented method exists |
| banner "showing N of M" | `Observation.limitation` aggregated by the controller |
| timeline | domain events for the investigation |
| Recent list | `{input, adapterId, datasetVersion, createdAt}` (DEC-023) |

## First live mapping: Bitcoin (2026-10-12)

| Model | Bitcoin source (Blockstream Esplora) |
|---|---|
| Entity `btc:wallet:<address>` (`kind: wallet`, `origin: live`) | an address that appears in a returned transaction |
| Attributes `balance`, `transactions` (root only) | `chain_stats` of `/address/<addr>` |
| Relationship `btc:rel:<from>><to>` (`interacts_with`, `direct`, directed) | input address to output address within one transaction; `amount` = value to the output in BTC, summed across transactions |
| Observation `btc:obs:tx:<txid>` | one transaction; `form: raw`; `status: ok` if confirmed, `partial` if pending; `observedAt` = block time; `url` = explorer link |
| Source `btc:source:blockstream` (`chain_record`) | `reference` is the API base; limitations state the recent-transactions cap |

See DEC-027 and DEC-028 for what a relationship does and does not claim.

## Mapping from today's simulation

| Today (`js/simulation.js`) | Replaced by |
|---|---|
| `evidence.refs` of target ids | `relationship.sourceEntityId` / `targetEntityId` plus a view-layer map from entity id to DOM target id |
| `evidence.source` string | `Source` + `Observation` records |
| `agent.finding_discovered` with free-text label | `relationship.discovered` domain event carrying a relationship id, mapped to the cue |

## Open questions (require owner approval)

- Which first real data vertical (on-chain wallet/token vs equities vs web sources)?
- Which chain(s) and provider(s), under what licence and rate limits?
- Stale thresholds per source.
- Whether user notes and hypotheses are in scope for the first release.
