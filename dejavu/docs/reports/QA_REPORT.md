# QA Report

Date: 2026-10-12. Method: Chrome (browser automation) at 1470x779 CSS px (DPR 2) and a 390 px iframe; Node 26 for logic checks; ffmpeg for media. Nothing here was run on Safari, Firefox, a real phone, or a screen reader.

## Automated checks

| Check | Result |
|---|---|
| `node --check` on every module | pass |
| `node tests/model.check.mjs` | 19 of 19 pass (11 listed plus ambiguity, Recent, needs-input, Bitcoin detection, normalization, live Verified, live flow, provider failure): dataset integrity, demo never verified, Verified rule (every failure reason), first neighborhood, capped expansion, input detection, unsupported input, demo reaches ready, expansion banner, selection and reset |
| Mermaid diagrams in docs | 7 of 7 parse |

## Manual verification (observed)

| Area | Observed |
|---|---|
| Landing | headline entrance sequence timed by sampling computed styles; settled about 2.8 s (since shortened to about 2.2 s, not re-sampled); no horizontal scroll at 390 px |
| Spider | walks with stepping legs; flees a click about 55 px away (about 340 px run); parks beside text; follows story steps; no console errors |
| Terrain | 229 foot plants in 14 s produced 46 strikes (about 20 percent), at most 4 heads and 46 segments; fully idle (no frame loop) after light fades |
| Background | original plays; poster fallback; Firefly seam score 0.28 (re-encode 0.62); switching is one setting |
| Tour and transition | guided tour scrolls and completes; Start walks the spider, changes route, hides the landscape and pauses video; Home restores both |
| Workspace | open demo, graph builds node by node; select node (brackets plus inspector); expand (banner "Showing 3 of 4 connections"); unsupported input shows "Not supported yet"; mobile tabs and sheet; labels readable at 390 px |
| Console | no application errors. One recurring error comes from a wallet browser extension (StacksProvider), not this app |
| Performance (baseline, not a pass or fail) | about 30 fps over 6 s with the spider ambient on landing, longest frame 35 ms, heap about 116 MB; measured in an automation-driven tab |

## Final-pass verification (observed in Chrome)

| Feature | Observed |
|---|---|
| Disambiguation | typing "token" shows two choices and fetches nothing until one is picked; picking opens it |
| Filters | choosing Transfer dims 4 edges, 3 nodes and 4 findings, count badge shows 1; Clear all restores everything |
| Timeline | collapsed bar shows the latest event and a count; toggling lists all events (20 rows after a run) |
| Keyboard | Enter selects a focused node, `E` expands it (9 entities and the "Showing 3 of 4" banner) |
| Recent | most recent leads listed on the empty state and reopen on click |
| Landing exit | headline lines leave through their masks; landing to workspace in 2.1 and 3.3 s in two runs; a click skips it in about 0.3 s and clears the leaving state |
| Console | only the wallet-extension error; no application errors |
| Brand | icon (dark tile with light spider) checked visually at 512 px; banner previewed in the browser with the real pixel font |

## Live data verification (observed against the real network)

| Check | Observed |
|---|---|
| Reachability | blockstream.info answers from the browser with CORS open (HTTP 200); address and transaction lists parsed |
| Open a real address (`1A1zP1e...DivfNa`) | chip "Bitcoin address", Live badge, 11 entities and 10 relationships, banner "Showing 10 of 25 connections"; took about 19 s end to end including the staged reveal |
| Verified | 8 of 10 relationships Verified (white edges); the other 2 are backed only by pending transactions and show "Not verified: there is no confirmed primary record" |
| Inspector | Verified chip, plain-language reason, and a working link to the transaction on blockstream.info (`rel="noopener noreferrer"`) |
| Expansion | expanding a live counterparty fetched its transactions and added a node |
| Offline tests | live flow and provider failure covered with a stubbed `fetch` |
| Spider checks | headline tear fired at 3.4 to 3.6 s after load (twice); intro walk restored after fixing a regression; time spent inside the headline area dropped from over 5 s to 1.8 to 2.8 s per 20 s |

## Issues found and fixed during the build

- (Regression, fixed) Page load restarted the spider's behavior and cancelled its intro walk; surface and Calm changes now only restart when they change.
- (Fixed) The spider treated reaching a detour waypoint as arrival; arrival now checks the real target.

- Stale browser cache hid module edits (added `serve.py` no-cache server).
- Workspace classes collided with the story graph (renamed to `ws-node`, `ws-edge`).
- First-line headline clipped by a 900 px container (widened).
- Graph never auto-fit after loading (fixed).
- Panels centered instead of filling height (fixed).
- Mobile top area crowded the graph; subject overlapped the Demo chip (fixed).
- A test expectation was wrong (4 connections, not 5), fixed in the test.

## Market terminal (2026-10-15): what was and was not checked

Checked: `node --check` on every module; `node tests/market.check.mjs` 23 of 23 and `node tests/model.check.mjs` 19 of 19; the Binance endpoints answered from the build machine with open CORS (klines, ticker, aggTrades).

Not checked: the page itself. The browser extension was not connected, so nothing was rendered or clicked. Untested in a browser: chart drawing, pan and zoom, marker alignment, the spider walking to markers, light strikes, mobile layout, the console, and whether the live poll behaves. Treat the market terminal as built and unit-tested, not verified.

## Known gaps and risks

1. Reduced motion verified by code path only, not by changing the operating-system setting.
2. (Fixed) Changing the system reduced-motion setting reloads the page into the right mode.
3. Any external `spider.cancelGoal()` outside the choreography ends the ambient loop permanently.
4. `shadowBlur` is used 7 times in canvas code; replace with pre-rendered glow sprites before profiling on real hardware.
5. (Fixed) The spider is scale 1.0 below 720 px; the scale is chosen at load, so resizing across the breakpoint needs a reload.
6. Terrain network is aligned to an average video frame; strikes can sit a few pixels off the drifting dunes.
7. (Fixed) The mobile legend is a collapsible `Legend` disclosure below 720 px.
8. No scope or time controls in the workspace (no data to scope yet).
9. Third-party requests remain: Google Fonts and the OnlineWebFonts display face (the unused Font Awesome stylesheet was removed).
10. Accessibility is partial: focus styles, labels, live regions, a list view alternative and a skip link, but no screen-reader pass.
11. Committed and pushed on branch `opencrawl` (commit 7792499), but inside the RunItBack repo; DEC-010 (own repo) is open.
12. Banner and social card PNGs were captured from the browser at about 1456 px wide (not 2x); `assets/brand/render.sh` re-renders them at higher resolution if you want to run it.
13. Live data depends on a third-party public API (rate limits and availability are outside this project); only recent transactions are read (25 confirmed plus pending), so counts are "of the most recent".
14. The spider still crosses the headline area for brief moments while leaving it.
15. Live graphs are laid out by a ring heuristic, so labels can overlap on dense nodes; zoom and list view are the workaround.
