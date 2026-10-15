# Product Brief

Status: **proposed** (positioning), with repository facts marked **confirmed by repository**. Governs scope and intent. Details live in the other docs; decisions live in `docs/DECISIONS.md`.

## What we are building

**OpenCrawl is an interactive intelligence and investigation workspace that helps people follow relationships between financial assets, wallets, transactions, and information found across the web. A procedural spider gives the system a visible presence and helps make the act of investigation understandable.** (proposed; validated as a coherent sentence, not as a claim of implemented capability)

Promise: **Follow the signal. See what connects. Understand why.**

The spider is the embodiment of attention. The investigation workspace is the product.

## What it is not

- A landing page with a spider and nothing behind it.
- A decorative sci-fi dashboard with invented numbers.
- A fake command line.
- An autonomous agent whose actions cannot be inspected or interrupted.
- A graph that implies a relationship without showing why it exists.
- A trading or execution product (no signing, custody, or recommendations).

## Who it is for

| User | Starts with | Needs |
|---|---|---|
| Curious investigator, crypto-native researcher (primary) | a token, wallet, ticker, transaction or URL | connected entities, why they connect, where each claim comes from |
| Market or on-chain analyst (secondary) | several leads and a time window | comparison, an auditable history of what was concluded and why |
| Agent-assisted browser researcher (secondary) | a question | to see what the agent does, what it observed, what is uncertain, and where it needs approval |

Principle: the agent may accelerate the investigation, but the user stays oriented and in control. Uncertainty, source gaps, failed actions, and demo data are never hidden behind a confident animation.

## Product principles

1. Signal over spectacle.
2. Every claim has a source.
3. Every relationship has a meaning (type, direction, time, source).
4. Progressive disclosure.
5. The user stays oriented (subject, scope, filters, time, history always visible).
6. Agent activity is observable, without exposing private reasoning.
7. Demo is never disguised as live.
8. Pointer and keyboard both work.
9. Motion has a reason and a reduced-motion form.
10. Failure, empty, partial, stale, and blocked states are designed.

## Capability status (verified 2026-10-11)

| Capability | Status | Where / note |
|---|---|---|
| Landing page: hero, how it works, honest status, final CTA | implemented | `index.html`, `styles.css` |
| Hero typography entrance, scroll reveals, story graph on scroll | implemented | `styles.css`, `js/motion.js` |
| Procedural spider (FABRIK legs, gait, DOM targeting, silk, flee/curious) | implemented | `js/spider/` |
| Terrain light layer (foot-contact strikes, scans, connection path) | implemented, original background only | `js/terrain/` |
| Background selection in one place | implemented | `js/background.js` |
| Event contract `agent.*` and investigation store | implemented | `js/spider/events.js`, `js/investigation.js` |
| Guided landing tour (simulated) | demo-only | `js/simulation.js` |
| Investigation workspace | partial, demo-only | `#terminal` in `index.html`, `js/workspace/`: search, SVG graph with select, expand, fit, list view, inspector with provenance, activity, Calm; no scope, time, filters, or timeline yet |
| Canonical model, demo dataset, Verified rule, domain events | implemented (demo-only) | `js/model/`, `js/investigation/` |
| Real data: Bitcoin mainnet addresses via the public Blockstream API | implemented (first vertical) | `js/investigation/bitcoin-adapter.js` |
| Other real data (other chains, market, web) | planned | none |
| Computer-use or browser agent | planned | none connected |
| Persistence, saved investigations, sharing | planned | none |
| Accounts, watchlists, alerts | planned, deferred | none |
| Trading, signing, custody | out of scope | not planned |
| Tests | partial | `node tests/model.check.mjs` (11 checks, no dependencies); no lint or build |

## Scope of the first working slice

Included: one coherent **demo** investigation on a deterministic dataset, running end to end in the terminal: start from a search, see the root subject in focus, select a node, select an edge, expand one relationship layer, inspect source/provenance, see an ordered activity timeline, reset to root. Demo labeled at all times. The spider and terrain light react to real events of this flow.

Explicitly deferred: live providers, the real agent, save/restore, accounts, sharing/export, watchlists, mobile polish beyond a usable layout, any trading or execution.

## Experience direction (design review 2026-10-12, proposed)

- **Final hero copy** (current, keep): eyebrow "MARKET INTELLIGENCE IN MOTION"; headline "Markets leave trails. / Follow them."; subhead "Trace the connections between stocks, tokens, wallets, and on-chain activity. Watch an agent investigate the signal."; CTAs "Start an investigation" and "Watch the spider work".
- **Experience thesis.** The visitor reads, then sees the creature act on a world that answers back, then opens a workspace where the same cause and effect shows real (eventually) relationships with evidence. The landing page promises only what the demo can show and says what is real.
- **Background.** Original grainy dune video is the definitive direction. The Firefly video stays an optional alternative; it is not used because its baked-in veins compete with the spider and cannot react to it (DEC-002).
- **Positioning.** Recommended: broad vision in the headline, narrow honesty in the product: "demo-first, on-chain first for real data" (unresolved, see DECISIONS).
- **Creative boundary.** OpenCrawl borrows restraint and framing ideas from Harmonic and GMUNK (see REFERENCE_LIBRARY); it does not borrow their palettes, graphics, or effects.

## Positioning, to be decided

DEC-adjacent open question (see roadmap and Section "Unresolved decisions" in the review summary): lead with **on-chain investigation**, **cross-domain financial intelligence**, or **web-intelligence agent for markets**. Proposal: broad vision in copy; demo-first MVP; first real vertical on-chain.

## Landing page content rules

No invented metrics, uptime, speed, or social proof. The landing page says what works, what is demonstration, and what is not connected (already implemented in `#status`). Copy follows `docs/design/DESIGN_SYSTEM.md` voice rules.
