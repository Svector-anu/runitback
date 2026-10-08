
## Agent B: persistence / app / audio / export / UI (outside engine command core)

Evidence is test names only (no commits). Vitest: `tests/regress-*.test.ts`; Playwright: `e2e/regressions.spec.ts`.

| Finding | Status | Evidence |
|---|---|---|
| P0-4 flush / close ordering | fixed | `regress-save-manager`: "waits for an in-flight save and also persists the edit made during it", "rejects when the final save fails..."; `regress-services`: "still saves the last edit when the thumbnail render fails", "keeps the project open and its media when saving fails" |
| P0-5 two tabs | fixed | `regress-locks-projects` (Web Locks exclusivity, delete refused while locked, sweep uses persisted row); `regress-services` "refuses to open a project another tab holds"; e2e "P0-5: a second tab..." (blocking screen "This project is open in another tab" + Try again) |
| P0-6 export missing media / lifecycle | fixed | `regress-export` (MissingMediaError up front; per-frame `missingMedia` also throws); `regress-services` "closing the project aborts a tracked export"; ExportButton aborts on unmount |
| P1-1 import into wrong project | fixed | `regress-services` "does not register into a project opened while the import was probing", "removes bytes stored for a project that closed during the write" |
| P1-2 open/close races | fixed | `regress-services` "the last requested project wins...", "StrictMode shape...", "a failed open does not wedge the queue"; e2e "P1-2: rapid project switches..." |
| P1-3 audio listener leak | fixed | `regress-services` "only the live project's engine reacts to edits..."; `regress-audio-engine` "does not create an AudioContext or timer" |
| P1-4 view-state commits | fixed outside editor core | audio restarts only when the document identity changes (`regress-services` "view-state writes do not restart audio"); SaveManager defers view-only commits by 5 s without flagging dirty (`regress-save-manager` P1-4). `Editor.setViewState` still fires `onCommitted` (editor core, not touched). |
| P1-5 stale audio cursor | fixed | `regress-audio-engine` "does not leave a stale cursor..." |
| P1-6 export cancelled by outside click/Esc | fixed | e2e "P1-6..."; Export button shows "Exporting N%" while the popover is closed |
| P1-7 Content textarea | fixed | e2e "P1-7..." |
| P1-8 Enter/Space swallowed | fixed | `regress-shortcut-guard`; e2e "P1-8..." (clips and playhead keep transport shortcuts by design) |
| P1-10 ASS quadratic strip | fixed | `regress-captions` "is linear on a hostile line..." |
| P1-11 unbounded cue times | fixed in parsers (24 h cap, 5 M char file cap) | `regress-captions` P1-11 tests; command-layer cap is editor core |
| P1-17 duplicate/delete atomicity | fixed | `regress-locks-projects` P1-17 tests |
| P2-4 visibilitychange listener leak (EditorPage) | fixed | no dedicated test |
| P2-5 beforeunload misses in-flight save | fixed | `regress-save-manager` "counts a save in flight as unsaved..." |

Deferred: P1-9 (pointercancel across controllers, needs touch/pen verification), P1-12/P1-13 (perf, need profiling), P1-14 (schema validation), P1-15 (command-layer param bounds, editor core), P1-16 (`src/platform/fonts.ts` not in ownership), P1-18 (history cap, editor core), P2-2/P2-3 (a11y), P2-6..P2-13, P2-1 (editor.ts). P0-1/2/3 skipped by instruction. Note: the orphan sweep now runs against the persisted row, but P0-1 (undo rewinding `doc.assets`) can still persist a shortened `assetIds`; fix that before relying on the sweep.

Behaviour changes for others: `AppServices` constructor takes optional `AppServicesDeps`; `closeProject()` now rejects with `SaveFailedError` (project stays open) and `openProject()` rejects with `ProjectLockedError`; `ProjectsService.delete` takes the project lock and rejects with `ProjectLockedError`; `ProjectsService.sweepOrphans(id)` added; `SaveManager.flush()` rejects on failure; `services.trackExport(controller)` registers exports to be aborted on close.

## Engine core (commands, editor, timeline, model, agent): P0-1, P0-2, P0-3, P1-11 (engine part), P1-15 (partial), P1-18

Tests: `tests/invariants-commands.test.ts` (37), `tests/invariants-fuzz.test.ts` (72: 24 seeds x 300 steps each for UI-reachable ops, hostile arguments on every command, and all agent tools via `createAgentTools`). Full suite 653 passing; `tests/agent` (152) unchanged. Mutation check: disabling the central invariant check makes 34 of these tests fail.

| Finding | Status | Where | Tests |
|---|---|---|---|
| P0-1 undo/redo rewinds `doc.assets` | Fixed | `CommandManager` no longer restores assets from snapshots. Each history entry carries `removedAssets`; undo re-adds them, redo removes them again, imports are never touched. `Editor.rollbackTransaction` merges instead of restoring the old list. `toProject().assetIds` = registry + every `mediaId` used by any scene + assets restorable by undo/redo (`Editor.retainedAssetIds`). | E7, E7b, "removing an asset is one undoable step", "assetIds never drop an asset a scene still references", both rollback tests, fuzz `finish()` asserts assets only grow |
| P0-2 NaN/Infinity/negative/fractional; poisoned commit | Fixed | `requireTick`/`guardElementPatch`/`requireFiniteParams` (`timeline/input-guards.ts`) used by `applyElementUpdate`, `insertElement`, `insertMediaElement`, `splitCommand`, `trimElementCommand`, `pasteCommand`, bookmarks, `updateSettings` (canvas <= 8192 side / 33 MP, fps 1..240), keyframe values, effect and mask params. Any `RangeError` from time arithmetic inside a command becomes `InvalidInputError`. `Editor.commit` computes durations before `set` and restores the previous state if reconcile throws; `execute` discards the history entry if commit fails. `coerceParam` now rejects Infinity. | E3 (per hostile value), E3b, E3d, E6, E9, keyframe NaN, settings, "command that throws midway" |
| P0-3 overlap / trim / duplicate ids | Fixed | `CommandManager.execute` runs `assertNoNewViolations` (timeline/invariants.ts) on every changed scene after ripple/prune, before recording history. Explicit placement now returns null on overlap (including the main-track pin-to-0 case). Duplicate element or track ids are rejected. Duration patches on trimmed media move `trimEnd` or are rejected if the source is too short. New `insertElementsOnLanes` puts overlapping clips on separate new tracks (caption import). | E1, E2, E4, E5, duplicate track ids, duration-vs-neighbour, lanes tests, paste, fuzz |
| P1-11 (engine part) | Fixed | `MAX_TIMELINE_TICKS` (24 h) enforced by guards and invariants. Parser-side cap is in `captions/` (agent F). | E3 `1e300` |
| P1-15 (partial) | Partial | Canvas/fps bounds and finite-number checks done. Per-definition `coerceParam` clamping of param values (blur 1e9 etc.) not wired in. | settings test |
| P1-18 | Fixed (engine) | History capped at `MAX_HISTORY_ENTRIES` (500, trimmed when no transaction is open). `Editor.preview` returns false instead of throwing for a stale plan and `commitPreview` returns false; stale-plan errors are now `InvalidInputError`. | E10, "history is capped", "invalid preview falls back" |

New public engine API: `assertDocumentInvariants(doc)`, `documentViolations`, `assertNoNewViolations`, `MAX_TIMELINE_TICKS` (timeline); `EngineError`, `InvalidInputError`, `InvariantViolationError` (model); `Editor.tryExecute(cmd) -> {ok:true} | {ok:false, error}`; `insertElementsOnLanes`; `withAssetList`; `MAX_HISTORY_ENTRIES`.

Invariant policy: an edit is refused only if it INTRODUCES a violation, so a project that was already damaged on disk still opens and can be repaired. Violations checked: current scene exists, unique scene/track/element ids, integer ticks, start >= 0, duration >= 1, trims >= 0, end <= 24 h, no overlap per track, `trimStart + duration*rate + trimEnd == sourceDuration` (+-2+rate), finite params.

Test adjusted (encoded now-forbidden behaviour): `tests/placement.test.ts` "explicit: returns a compatible track...": its first assertion used an overlapping span on `o1`; it now uses a free span and a second assertion expects `null` for the overlapping span.

Behaviour changes for UI/agents: `Editor.execute` throws a typed `EngineError` (state untouched) for malformed or invariant-breaking commands; `tryExecute` returns it as a value. `Editor.preview`/`commitPreview` now return boolean. A negative `startTime` patch is still clamped to 0 (unchanged); non-finite or fractional ones are rejected. Agent tools surface rejections as `ok:false` through the existing translation, and no tool leaves partial edits (fuzz-verified).

Deferred / for other owners:
- UI (agent F): captions import (`src/ui/assets/OtherViews.tsx`) still uses `addTrack` + explicit `insertElement` per cue; with overlapping cues it now fails with a visible error instead of corrupting the track. Switch it to `insertElementsOnLanes({ elements })` (one command, also fixes P2-13 O(n^2)). Drag controllers can use the boolean from `preview`/`commitPreview`. Add the ErrorBoundary from P0-2(c). Callers of `editor.execute` in UI handlers should prefer `tryExecute` and toast `error.message`.
- Persistence (agent F): `validateProject` should run `documentViolations` on load (P1-14); `collectOrphans` should treat `assetIds` as authoritative (it now includes undo-restorable assets).
- P1-4 (`setViewState` fires `onCommitted`): not changed, because `app/services.ts` and the save manager depend on that signal; needs a separate `onViewChanged` channel coordinated with them.
- P1-15 param clamping via definitions, P2-1 schema version constant (persistence import), not done.
