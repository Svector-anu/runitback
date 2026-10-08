# 02 - Core, commands, history, clipboard, project model, persistence, shortcuts (OpenCut classic)

Root: `.../ref-classic/repo/apps/web/src` (abbrev `src/`). Everything is browser-local; the server is not involved in editing. Line refs are `file:line`.
Not read in depth: individual migration transformers v1..v30 (only runner, index, v30-to-v31, names of the rest); animation/effects/masks/placement internals; renderer; Rust crates (only TICKS_PER_SECOND).

## 1. Architecture overview

- `EditorCore` singleton (`src/core/index.ts:17-81`), `getInstance()` / `reset()`. Plain TS classes, NOT React. Each manager holds private state + `listeners:Set<()=>void>` + `subscribe(fn)->unsubscribe` + `notify()`.
- Managers (constructed in this order, index.ts:33-46): `command`, `timeline`, `playback`, `scenes`, `project`, `media`, `renderer`, `save`, `audio`, `selection`, `clipboard`, `diagnostics`. Constructor also calls `registerDefaultEffects()`, `registerDefaultMasks()`, `playback.bindTimelineScope()`, registers one **command reactor**, then `save.start()`.
- **Reactor** (index.ts:49-67): after every command execute/redo, prune `overlay` and `audio` tracks with 0 elements (main track never pruned) via `timeline.updateTracks`. So empty tracks vanish automatically (and are restored by undo because undo restores the whole tracks snapshot).
- React binding: `useEditor()` (`src/editor/use-editor.ts`) = `useSyncExternalStore` over subscribe-to-all-managers (playback, timeline, scenes, project, media, renderer, selection, clipboard, diagnostics). `useEditor(selector)` caches snapshot, shallow-compares arrays (Object.is per item). `useEditor()` with no selector returns the editor without subscribing.
- Zustand stores are UI-only: `useTimelineStore` (snappingEnabled=true, rippleEditingEnabled=false, expandedElementIds; persisted `timeline-store`, only the two booleans), `useEditorStore` (isInitializing, isPanelsReady, canvasPresets), `usePanelStore` (panel sizes; `panel-sizes` v2), `useKeybindingsStore`, `usePreviewStore` (`preview-settings` v6), `useProjectsStore` (`projects-view-mode`: viewMode/sortKey/sortOrder), stickers store (`stickers-settings` v1), graph-editor presets.
- Source of truth for document: `SceneManager.list: TScene[]` (+ `active`), mirrored into `project.active.scenes` on each change; `project.saveCurrentProject()` reads `scenes.getScenes()` (project-manager.ts:193).
- Rule (AGENTS.md): business logic is migrating to `rust/` (wasm pkg `opencut-wasm`: time math, FrameRate, timecode parsing). Web is a UI shell. Time constants come from Rust: `TICKS_PER_SECOND = 120_000` (`rust/crates/time/src/media_time.rs:10`).
- Time type: `MediaTime = number & brand`, an INTEGER tick count (`src/wasm/media-time.ts`); `roundMediaTime` rounds half away from zero; helpers add/sub/min/max/clamp/mediaTimeFromSeconds. `FrameRate = {numerator:number; denominator:number}` (opencut-wasm). DEFAULT_FPS=30/1 (`fps/defaults.ts`). `DEFAULT_NEW_ELEMENT_DURATION` = 5 s (`timeline/creation.ts`).
- Convention: all functions take a single object param (`fn({a,b})`), enforced by a lint rule `opencut/prefer-object-params`.

### Managers - responsibilities
- **PlaybackManager** (core/managers/playback-manager.ts): isPlaying, currentTime (MediaTime), volume/muted/previousVolume, isScrubbing. rAF loop (`updateTime`), time = start + wall elapsed, snapped via `roundFrameTime(fps)`; auto-pauses and clamps at total duration. `play()` no-ops if duration<=0; restarts from 0 if at end. `seek` clamps [0,duration]. `onUpdate`/`onSeek` listeners. Re-clamps time whenever timeline/scenes change (`reconcileTimelineScope`). Playhead is NOT undoable and NOT in autosave dirty triggers (but see timelineViewState below).
- **SelectionManager** (selection-manager.ts): `selectedElements: ElementRef[]`, `selectedKeyframes: SelectedKeyframeRef[]`, `keyframeSelectionAnchor`, `selectedMaskPoints`. Mutually exclusive-ish: setSelectedElements clears keyframes+mask points. `getActiveSelectionKind()` priority: mask-points > keyframes > elements. `clearMostSpecificSelection()` peels one layer. `getSnapshot/restoreSnapshot/applySelectionPatch`.
- **ScenesManager**: list/active scenes, createScene/deleteScene/renameScene/switchToScene (switchToScene is NOT a command, not undoable), bookmark ops (commands), `updateSceneTracks({tracks})` (sets updatedAt, mirrors into project).
- **TimelineManager**: thin facade creating commands (see section 3) + preview overlay system + queries (`getTotalDuration`, `getElementsWithTracks`, `getTrackById`, `getLastFrameTime`).
- **MediaManager**: in-memory `assets: MediaAsset[]`; `addMediaAsset` (non-command path: optimistic add, `storageService.saveMediaAsset`, ratchet fps, rollback + quota toast on failure); `removeMediaAsset(s)` -> command(s); `loadProjectMedia`; `clearAllAssets` revokes object URLs and clears videoCache/waveformCache.
- **SaveManager**: autosave, section 5. **ClipboardManager**: section 6. **ProjectManager**: section 7. Renderer/Audio/Diagnostics out of scope here.

## 2. Undo/redo (history) mechanism

`CommandManager` (`core/managers/commands.ts`):
```ts
interface CommandHistoryEntry { command: Command; previousSelection: EditorSelectionSnapshot; selectionOverride?: EditorSelectionSnapshot }
history: CommandHistoryEntry[]  // unbounded, in-memory only, NOT persisted
redoStack: CommandHistoryEntry[]
reactors: Array<() => void>
public isRippleEnabled = false  // set by EditorRuntimeBindings from useTimelineStore.rippleEditingEnabled (components/providers/editor-provider.tsx:136-138)
```
- `execute({command})` (21-37): snapshot tracks if ripple on; snapshot selection; `command.execute()`; apply ripple; apply `result.selection` patch if returned (stores resulting snapshot as `selectionOverride`); run reactors; push entry; **clear redoStack**; returns the command.
- `push({command})` (39-45): record an already-applied command (used by `commitPreview`), redo cleared, no execute.
- `undo()` (51-68): pop, `command.undo()`; **restore `previousSelection` only if the entry had a `selectionOverride`** (commands that didn't change selection leave UI selection alone); push to redoStack. Ripple is NOT re-applied on undo (undo restores snapshot).
- `redo()` (70-91): pop redo, `command.redo()` (default = `execute()` again), ripple/selection/reactors again, push back to history.
- `canUndo/canRedo/clear()`. `clear()` is never called anywhere (grep) - history survives project switches within a session (probable latent bug; flag: loadProject/closeProject do not clear it).
- **There is no time-based grouping/coalescing.** Grouping is explicit:
  - `BatchCommand(commands[])` (commands/batch-command.ts): execute in order, undo in REVERSE, redo in order; returns last command result that carried a selection. Used for multi-keyframe upsert/remove/curve updates and multi-asset removal.
  - **Preview/commit for drags** (timeline-manager.ts:702-767): `previewElements({updates})` accumulates a `previewOverlay: Map<elementId, Partial<TimelineElement>>` and a `previewTracks` copy (applied on top of committed tracks, NOT in scene state, no history, no autosave). `commitPreview()` builds `TracksSnapshotCommand({before: committedTracks, after: previewTracks})`, `command.push` (no re-execute), clears overlay, then `updateTracks(after)`. `discardPreview()` drops overlay. `updateTracks` always clears any preview. Used by preview-canvas transform handles, properties-panel sliders (`use-keyframed-param-property.ts`), speed tab.
  - `pushHistory:false` option on `updateElements`, `updateElementTrim`, `updateElementRetime`, `updateClipEffectParams`, `project.updateSettings` -> runs `command.execute()` directly with no history entry (used for live drag updates).
  - `PreviewTracker<T>` (commands/preview-tracker.ts): tiny helper that `structuredClone`s a state on first `begin()`; (no usages found by grep outside its file).
- **Storage of undo data**: nearly every command stores `savedState = editor.scenes.getActiveScene().tracks` (a whole `SceneTracks` object, cheap because state is immutable/structurally shared) and `undo()` calls `timeline.updateTracks(savedState)`. Scene/bookmark commands store `savedScenes = [...scenes]` and call `scenes.setScenes`. Project settings command stores previous settings + updatedAt. Media commands store asset list + tracks. Consequence: undo is snapshot-based per active scene; undoing after switching scene would write old tracks into the CURRENT active scene (flag: no scene id guard in tracks-based commands).
- Reactor/prune + ripple run inside execute; ripple (`src/ripple/{diff,apply,shift}.ts`): diff before/after tracks -> `RippleAdjustment[]` (freed intervals = vacated minus joined, per track) -> shift later elements left, then `updateTracks`.

`Command` base (commands/base-command.ts): `abstract execute(): CommandResult|undefined`; `undo()` default throws; `redo()` default = execute. `CommandResult = { selection?: EditorSelectionPatch }`; helper `createElementSelectionResult(refs)` -> select those elements, clear keyframes/anchor/mask-points.

## 3. Command list (src/commands/**) and semantics

All timeline commands: snapshot `savedState = activeScene.tracks`, mutate immutably, `timeline.updateTracks(new)`; undo restores snapshot. Return selection where noted.

Timeline - tracks (commands/timeline/track/):
- `AddTrackCommand({type:TrackType,index?})` - new empty track (uuid at construction, `getTrackId()`); audio goes to `tracks.audio` (insert index = displayIndex - overlay.length - 1), others into `tracks.overlay` (clamped). Default index from `getDefaultInsertIndexForTrack`.
- `RemoveTrackCommand(trackId)` - filters overlay and audio only (main can't be removed).
- `ToggleTrackMuteCommand(trackId)` (if `canTrackHaveAudio`), `ToggleTrackVisibilityCommand(trackId)` (if `canTrackBeHidden`) - flips `muted` / `hidden`.
Timeline - elements (commands/timeline/element/):
- `InsertElementCommand({element:CreateTimelineElement, placement})`, placement = `{mode:"explicit",trackId}` | `{mode:"auto",trackType?,insertIndex?}`. Validates (mediaId for media types; library audio needs sourceUrl; sticker needs stickerId; graphic needs registered definitionId; text needs params.content; effect needs effectType). New uuid id; defaults trimStart/trimEnd=0, duration=5s. Placement via `resolveTrackPlacement`(strategy explicit | firstAvailable) + `applyPlacement`; may create a track, may adjust startTime. **If it's the very first element on the timeline and visual media**: sets project canvasSize to asset width/height (+ `originalCanvasSize` if unset) and fps to asset fps (video) via `project.updateSettings(pushHistory:false)` - NOT undone by undo. Returns selection = the new element.
- `UpdateElementsCommand({updates:[{trackId,elementId,patch}]})` - applies `applyElementUpdate` pipeline per entry (src/timeline/update-pipeline.ts).
- `DeleteElementsCommand({elements})` - removes from all tracks; selection cleared (empty selection patch).
- `DuplicateElementsCommand({elements})` - per source track: copies (name `"<name> (copy)"`, same startTime, new uuid, `cloneAnimations(regenerate keyframe ids)`) placed on a NEW track above (strategy alwaysNew/highest); selects duplicates.
- `SplitElementsCommand({elements,splitTime,retainSide:"both"|"left"|"right"})` - for elements whose span strictly contains splitTime. Left keeps id (`" (left)"`), right gets new id (`" (right)"`), startTime=splitTime. Source-span math honors `retime` (rounded once; right = total - left). trimEnd(left)+=rightSourceSpan, trimStart(right)+=leftSourceSpan; animations split via `splitAnimationsAtTime(includeBoundary)`. retainSide left -> keep left only (same id); right -> keep right only with NEW id. Selects right-side pieces (`getRightSideElements()`).
- `MoveElementCommand({moves:PlannedElementMove[],createTracks?})` - creates tracks (sorted by index), validates element/track compatibility (throws on failure), sets startTime, moves across tracks; selects moved elements.
- `ToggleSourceAudioSeparationCommand({trackId,elementId})` - video only: if audio already separated -> re-enable `isSourceAudioEnabled=true`; else extract audio element (`buildSeparatedAudioElement`) into first-available audio track and set video `isSourceAudioEnabled=false`. Needs `canExtractSourceAudio` and duration>0.
- Paste: `PasteCommand({time,clipboardItems})` (below), `PasteKeyframesCommand({trackId,elementId,time,clipboardItems})`.
- Keyframes (element/keyframes/): `UpsertKeyframeCommand({trackId,elementId,propertyPath,time,value,interpolation?,keyframeId?})` (time clamped [0,duration], needs a resolvable animation target); `RemoveKeyframeCommand({...,keyframeId,valueAtPlayhead})` (if last keyframe of a path removed, the value at playhead is baked into the base value: WYSIWYG); `RetimeKeyframeCommand({...,keyframeId,nextTime})`; `UpdateScalarKeyframeCurveCommand({...,componentKey,keyframeId,patch:ScalarCurveKeyframePatch})`; `UpsertEffectParamKeyframeCommand({trackId,elementId,effectId,paramKey,time,value,interpolation?:"linear"|"hold",keyframeId?})`; `RemoveEffectParamKeyframeCommand({...,paramKey,keyframeId})`.
- Effects (element/effects/, visual elements only): `AddClipEffectCommand({trackId,elementId,effectType})` (appends `buildDefaultEffectInstance`; `getEffectId()`), `RemoveClipEffectCommand`, `ToggleClipEffectCommand` (enabled flip), `UpdateClipEffectParamsCommand({...,effectId,params:Partial<ParamValues>})`, `ReorderClipEffectsCommand({...,fromIndex,toIndex})`.
- Masks (element/masks/, video/image/graphic only): `RemoveMaskCommand`, `ToggleMaskInvertedCommand({...,maskId})` (flips `params.inverted`), `InsertFreeformPathMaskPointCommand({...,maskId,segmentIndex,canvasPoint,bounds})`, `DeleteFreeformPathMaskPointsCommand({...,maskId,pointIds})` (updates `closed` per remaining count). (Adding a mask is done through `UpdateElementsCommand` patch; no AddMask command exists.)
- `TracksSnapshotCommand({before,after})` - generic whole-tracks swap; used by commitPreview.
Scenes (commands/scene/): `CreateSceneCommand({name,isMain?})`, `DeleteSceneCommand(sceneId)` (refuses main scene; fallback active = main), `RenameSceneCommand({sceneId,newName})`, `ToggleBookmarkCommand(time)`, `RemoveBookmarkCommand(time)`, `UpdateBookmarkCommand({time,updates})`, `MoveBookmarkCommand({fromTime,toTime})`. Bookmark times are frame-snapped via `getFrameTime({time,fps})`. All store `savedScenes` and restore with `setScenes`. NOTE: `ScenesManager.deleteScene` etc. are `async` but only sync inside.
Media (commands/media/): `AddMediaAssetCommand({projectId,asset})` (sync add to memory, fire-and-forget `saveMediaAsset`; on failure rollback assets, delete orphaned timeline elements, restore fps, quota toast; undo deletes from storage) - note MediaManager.addMediaAsset is a separate non-command path; `RemoveMediaAssetCommand({projectId,assetId})` (revokes URLs, clears video/waveform caches, deletes dependent timeline elements via `timeline.deleteElements` (itself a nested history entry!), deletes from storage async; undo recreates object URL, re-saves to storage, restores tracks).
Project (commands/project/): `UpdateProjectSettingsCommand(Partial<TProjectSettings>)` (merge, bumps updatedAt, markDirty; undo restores settings+updatedAt).

TimelineManager convenience methods (not commands): `toggleElementsVisibility` (hide all if any visible, else show; only `canElementBeHidden`), `toggleElementsMuted` (sets `params.muted`), both via `updateElements`.

## 4. Keyboard shortcuts / actions system

Files: `src/actions/{definitions.ts,types.ts,keybinding.ts,keybindings-store.ts,use-keybindings.ts,use-action-handler.ts,use-editor-actions.ts,registry.ts,keybindings/**}`, `docs/actions.md` (its paths are stale: says `src/lib/actions`, `src/stores`, `src/hooks/actions`; real ones are under `src/actions/`).

Layers: (1) `ACTIONS` registry (description, category in playback|navigation|editing|selection|history|timeline|controls|assets, optional `args`) + separate `ACTION_DEFAULT_SHORTCUTS` table; (2) `bindAction/unbindAction/invokeAction` in a module-level registry of handler arrays (`registry.ts`) - an action may have many handlers, all invoked; (3) `useActionHandler(action, handler, isActive)` React hook binds in effect (isActive: undefined=always, boolean, or ref); (4) `useEditorActions()` registers every handler (mounted once in `EditorRuntimeBindings`); (5) `useKeybindingsListener()` global `keydown` on `document`, capture phase.
`TInvocationTrigger = "keypress"|"mouseclick"`. UI should call `invokeAction(...)` rather than `editor.*` so toasts/validation/keybindings apply.

Key syntax: `ShortcutKey = Key | "${ModifierKeys}+${Key}"`; Modifiers: ctrl, alt, shift, ctrl+shift, alt+shift, ctrl+alt, ctrl+alt+shift (ctrl = Cmd on Apple via `isAppleDevice()`, alt = Option). Key set: a-z, 0-9, up/down/left/right, `/`, `?`, `.`, enter, tab, space, escape, esc, backspace, delete, home, end. Letters/digits resolved by physical `ev.code` (KeyX/DigitN) for AZERTY etc.

Listener rules (use-keybindings.ts:24-72):
- Ignored entirely when `overlayDepth>0` (any open dialog/popover registered via `useOverlayOpenChange`), `isLoadingProject`, or `isRecording` (shortcut-rebind dialog).
- Binding string computed by `getKeybindingString`: returns null if target is a typable element (input/textarea/contenteditable via `isTypableDOMElement`) for bare keys and shift combos.
- If Escape pressed while a text input is focused: blur it, stop.
- If target is typable at all -> return (so ctrl+z etc. do NOT fire the editor undo in text fields).
- `paste-copied`: only handled (and preventDefault) when `editor.clipboard.hasEntry()`; otherwise the event passes through so native paste -> `usePasteMedia` (media/use-paste-media.ts) can ingest images/files.
- Every other matched binding: `preventDefault()` then `invokeAction`. seek-forward/-backward pass `{seconds:1}`, jump-forward/-backward `{seconds:5}`.

### Default shortcut table (definitions.ts:~156-176; `getDefaultShortcuts()`)
| key | action | what it does (use-editor-actions.ts) |
|---|---|---|
| space, k | toggle-play | playback.toggle |
| l | seek-forward (1 s) | seek min(totalDuration, t+1s) |
| j | seek-backward (1 s) | seek max(0, t-1s) |
| right | frame-step-forward | + one frame (120000*den/num ticks), clamped to duration |
| left | frame-step-backward | - one frame, clamp 0 |
| shift+right | jump-forward (5 s) | |
| shift+left | jump-backward (5 s) | |
| home, enter | goto-start | seek 0 |
| end | goto-end | seek total duration |
| s | split | split selected elements at playhead, or all elements under playhead if none selected |
| q | split-left | split, keep RIGHT (retainSide "right"); if ripple on, seek to the right piece's start |
| w | split-right | split, keep LEFT (retainSide "left") |
| backspace, delete | delete-selected | by active selection kind: mask-points -> delete points; keyframes -> remove keyframes + clear kf selection; elements -> delete elements |
| ctrl+c | copy-selected | clipboard.copy |
| ctrl+v | paste-copied | clipboard.paste at playhead (only if clipboard non-empty) |
| n | toggle-snapping | timeline store |
| ctrl+a | select-all | all elements in overlay, main, audio tracks of active scene |
| escape | cancel-interaction | run registered cancellers (drag etc.) -> if none, invoke deselect-all |
| ctrl+d | duplicate-selected | |
| ctrl+z | undo | |
| ctrl+shift+z, ctrl+y | redo | |
Actions with NO default shortcut (UI/menu only or user-bindable): stop-playback (pause + seek 0), toggle-ripple-editing, toggle-source-audio (requires exactly 1 selected element, `canToggleSourceAudio`), deselect-all (clearActiveScope() else clearMostSpecificSelection()), toggle-elements-muted-selected, toggle-elements-visibility-selected, toggle-bookmark (at playhead), remove-media-asset `{projectId,assetId}`, remove-media-assets `{projectId,assetIds}`.
Context note: there is no per-panel context system; all shortcuts are global to the editor page, gated only by overlay/typing/loading. A "scope" mechanism (`selection/scope.ts`, `activateScope/clearActiveScope`) lets the timeline selection claim the Escape/deselect behavior.

Persistence of bindings: zustand persist key `opencut-keybindings`, version `CURRENT_VERSION=7` (migrations/index.ts), partialize = `{keybindings: Record<key,action>, isCustomized}`. Migrations (keys are persisted-version numbers): v2->3 renames split-selected(-left/-right)->split(-left/-right); v3->4 paste-selected->paste-copied; v4->5 add `escape: deselect-all` if unbound; v5->6 escape deselect-all -> cancel-interaction; v6->7 split-element -> split. Rule from docs/actions.md: new default shortcuts only reach existing users via a migration (persisted map is a full copy of defaults at first save). Store also: `updateKeybinding`, `removeKeybinding`, `resetToDefaults`, `importKeybindings` (strict parse via `parseImportedKeybindings`), `exportKeybindings`, `validateKeybinding` (conflict = same key bound to different action; rebinding UI replaces all old keys of that action with the single new key). `decodePersistedKeybindingsState` is lossy (drops invalid entries with console.warn). Shortcuts dialog: `actions/components/shortcuts-dialog.tsx` (reachable from editor header project dropdown `"shortcuts"`); help list generated by `use-keyboard-shortcuts-help.ts` sorted by category then description, pretty-printing ctrl->platform key, arrows, etc.

Hard-coded (non-action) keys seen: Enter/Escape in rename/timecode/number/colour inputs; Arrow keys on playhead handle (timeline-playhead.tsx:91); Enter/Space activation on cards in projects page. The shift key is tracked by `hooks/use-shift-key.ts` (modifier for snapping/range select).

## 5. Persistence layers - what goes where

| Data | Store | Key/location | When written |
|---|---|---|---|
| Project document (metadata, scenes, tracks, settings, version, timelineViewState, thumbnail data-URL) | IndexedDB db `video-editor-projects`, object store `projects`, keyPath `id` (version 1) | key = project id; value = `{id, ...SerializedProject}` (adapter spreads `{id:key,...value}`) | autosave (800 ms debounce), createNewProject, rename, duplicate, thumbnail, migrations |
| Media metadata | IndexedDB db `video-editor-media-<projectId>`, store `media-metadata` | key = asset id | `saveMediaAsset` |
| Media bytes | OPFS directory `media-files-<projectId>` (file name = asset id) via `OPFSAdapter` (`navigator.storage.getDirectory`) | | `saveMediaAsset` (write file first, then metadata; on failure remove file + throw `StorageQuotaExceededError` if quota) |
| Saved sounds | IndexedDB db `video-editor-saved-sounds`, store `saved-sounds`, single record key `user-sounds` = `SavedSoundsData{sounds:SavedSound[],lastModified}` | | on save/remove sound |
| Keybindings | localStorage `opencut-keybindings` (zustand persist) | | on change |
| Panel sizes `panel-sizes`(v2), `preview-settings`(v6), `timeline-store`(snapping, ripple), `projects-view-mode`, `stickers-settings`(v1), `graph-editor-presets`, `last-seen-version`(changelog), `mobile-acknowledged`, `feedback-history`, `opencut-storage-persist-dismissed` | localStorage | | UI |
| Undo history, clipboard, selection, playback time/volume | memory only | lost on reload | |
| Server (Postgres via Drizzle) | NOT used for projects/media at all | | |
- StorageService (`services/storage/service.ts`) is a singleton `storageService`. Config constants: projectsDb `video-editor-projects`, mediaDb prefix `video-editor-media`, savedSoundsDb `video-editor-saved-sounds`, adapter version 1 (`service.ts:61-66`).
- `IndexedDBAdapter<T>` (`indexeddb-adapter.ts`): opens the DB on EVERY operation (no connection cache), `createObjectStore(storeName,{keyPath:"id"})` on upgrade, methods get/set({key,value})/remove/list/getAll/clear + `deleteDatabase`. `OPFSAdapter` implements get/set/remove/list/clear for `File`.
- `SerializedProject`: dates -> ISO strings (`createdAt`,`updatedAt` for project metadata and each scene). `saveProject` strips `AudioElement.buffer` (AudioBuffer) from audio tracks (`stripAudioBuffers`). `loadProject` rehydrates Dates, rounds `metadata.duration` to MediaTime, `normalizeBookmarks` (legacy numbers -> `{time}`), `currentSceneId || ""`.
- Quota: `quota.ts`: `readStorageQuotaStatus` via `navigator.storage.estimate`; `STORAGE_HEADROOM_RESERVE_BYTES = 50 MiB` reserved; `canStoreFile({size})` -> `{canStore, reason:"enough-space"|"insufficient-space"|"estimate-unavailable"}` (unknown estimate = allow); `isStorageQuotaExceededError` matches name QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED / message contains "quota".
- Persistent storage request (`use-storage-persistence.ts`): on mount, if `navigator.storage.persist` exists and not yet persisted and dismissed flag not set: Firefox -> show confirm dialog (`storage-persistence-dialog.tsx`), others -> call `navigator.storage.persist()` silently.
- Known data-loss gap: `MediaAssetData` declares `fps` and `hasAudio` but `saveMediaAsset` doesn't write them and `loadMediaAsset` doesn't return them (service.ts:297-308, 370-382). After reload `asset.fps/hasAudio` are undefined (affects fps ratchet / source audio extraction decisions - verify before copying). Also a cached `thumbnailUrl` is saved as stored string (object-URL-ish; may be stale after reload) - unverified.

### Autosave (`SaveManager`, core/managers/save-manager.ts)
- `debounceMs = 800` (default). Subscribes (in `start()`, called from EditorCore constructor) to `scenes` and `timeline` managers: ANY change calls `markDirty()`. Also explicit `markDirty()` from: UpdateProjectSettingsCommand, `project.updateThumbnail`, `project.setTimelineViewState`; `markDirty({force:true})` when `initializeScenes` had to add a main scene.
- `markDirty`: ignored while paused unless forced; sets `hasPendingSave`; (re)starts the debounce timer unless a save is in flight.
- `saveNow`: skips if saving, nothing pending, no active project, project loading, or storage migration in progress; sets isSaving; `project.saveCurrentProject()` (merges scenes, recomputes `metadata.duration` from main scene, `updatedAt=now`, `storageService.saveProject`, updates in-memory + saved list; errors only `console.error`, NOT retried and the dirty flag was already cleared); on finish re-queues if dirty again.
- `pause()` during `loadProject` (so loading does not trigger saves) and `resume()` in finally (re-queues if pending). `flush()` forces immediate save (used by `prepareExit`).
- `getIsDirty()` drives a `beforeunload` prompt (editor-provider.tsx:140-149). No visibilitychange/pagehide save.
- Settings changes (fps/canvas/background) save only through the command's `markDirty`. Media files are saved immediately at import time (not via autosave).
- Thumbnail: generated if missing on load and again on `prepareExit` (editor header Exit): renders frame at t=0 of the timeline with `CanvasRenderer` at full canvas size -> `toDataURL("image/png")` -> `metadata.thumbnail` (stored inline in IndexedDB project record, so large).

### Schema versioning / migrations (`services/storage/migrations/`)
- `CURRENT_PROJECT_VERSION = 31` (migrations/index.ts:36); `TProject.version` stored on the record. List of 31 `StorageMigration {from,to,run({projectId,project})}` classes, each delegating to a pure `transformProjectVxToVy({project}) -> {project, skipped, reason?}` in `transformers/` operating on loose `Record<string,unknown>`.
- Policy (`migrations/AGENTS.md`): migrations are ADDITIVE ONLY - never delete/rename/replace persisted fields, add new ones alongside old ones, so down-migrations remain possible.
- Runner (`runner.ts`): reads all project records from `video-editor-projects`/`projects`; per project determines version (`version` number, else v1 if has non-empty `scenes`, else v0); applies migrations sequentially by `from`; each result written back immediately; if a transformer returns `skipped` the chain stops for that project. Reports `MigrationProgress` to the UI (`MigrationDialog`, non-dismissable) and enforces a MIN 1000 ms display time. One-time `deleteDatabase("video-editor-meta")` cleanup.
- Triggers: `ProjectManager.ensureStorageMigrations()` (memoized promise) before `loadProject` and `loadAllProjects`; also `StorageService.ensureMigrations()` before loadProject / loadAllProjectsMetadata (separate memoized promise, no progress callback).
- Version meaning (from filenames/functions; internals of most not read): 0->1 add scenes; 1->2 tracks restructured (media/text/audio track transform, big); 2->3 scenes/duration normalization; 3->4 text font weights; 4->5 sticker elements; 5->6 bookmarks (numbers -> objects); 6->7, 8->9 text elements; 7->8 element migration; 9->10 ?; 10->11 scale; 11->12 position; 12->13 masks; 13->14 split-mask params (position-along-normal -> x,y anchor); 14->15 frozen fallback; 15->16 sticker tracks renamed to graphic; 16->17 backfill mask strokeAlign; 17->18 volume linear gain -> dB (clamped); 18->19 canvas size settings (canvasSizeMode etc.); 19->20 video source-audio state; 20->21 background blur scale; 21->22 animations -> channel model with linear-RGBA colours (545 lines); 22->23 time -> integer ticks (metadata, settings, timelineViewState, scenes); 23->24 main track split out of flat track array; 24->25 tracks/elements/animations reshape; 25->26 repair of broken 24->25 output (numeric-keyed object -> array); 26->27 freeform path points; 27->28, 28->29, 29->30 per-element reshapes (params model); 30->31 mask type `"custom"` -> `"freeform"`.
- **Bug/uncertainty in this snapshot**: `runner.ts:41-45` constructs `new IndexedDBAdapter<ProjectRecord>("video-editor-projects","projects",1)` with positional args, but the adapter constructor takes an object `{dbName,storeName,version}` (indexeddb-adapter.ts:8-16), and `runner.ts:98` calls `projectsAdapter.set(projectId, result.project)` vs `set({key,value})`. As written these calls look incompatible (would open a DB named `undefined` and throw on set). Tests exist for transformers only. Treat the runner as needing a fix in a rebuild; do not copy verbatim.
- Other quirk: `loadAllProjects()` in service calls `loadProject` per id; `loadAllProjectsMetadata()` (used by the list page) pulls `getAll()` and maps metadata only (but still loads full scenes into memory because stores are single records).

## 6. Clipboard (`src/clipboard/**`, `core/managers/clipboard-manager.ts`)

- In-memory only (NOT the system clipboard). `ClipboardManager.entry: ClipboardEntry|null`.
```ts
interface ElementClipboardItem { trackId: string; trackType: TrackType; element: CreateTimelineElement /* element minus id */ }
interface KeyframeClipboardCurvePatch { componentKey: string; patch: ScalarCurveKeyframePatch }
interface KeyframeClipboardItem { propertyPath: AnimationPath; timeOffset: MediaTime; value: ParamValue; interpolation: AnimationInterpolation; curvePatches: KeyframeClipboardCurvePatch[] }
interface ElementsClipboardEntry { type: "elements"; items: ElementClipboardItem[] }
interface KeyframesClipboardEntry { type: "keyframes"; sourceElement: ElementRef; items: KeyframeClipboardItem[] }
type ClipboardEntry = ElementsClipboardEntry | KeyframesClipboardEntry
interface ClipboardHandler<T> { type:T; canCopy(ctx:CopyContext):boolean; copy(ctx):Entry|null; paste({entry,context}):Command|null }
```
- Handler chain order for copy: **keyframes first, then elements** (`clipboardCopyHandlers`, handlers/index.ts:17-20): if any keyframes are selected, copy keyframes (must all belong to one element, else copy returns null and nothing copies); else if elements selected, copy elements.
- Elements copy: `getElementsWithTracks` -> items drop `id`, keep trackId/trackType. Paste -> `PasteCommand({time: playhead, clipboardItems})`: relative offsets from earliest start preserved; each source track group placed with strategy `aboveSource` (new track above, or existing track if free/compatible); on main track, `enforceMainTrackStart` may shift to 0; new uuids, animation keyframe ids regenerated (`cloneAnimations`); pasted elements become the selection.
- Keyframes copy: records value, interpolation, curve handles/tangent per scalar component, `timeOffset` relative to earliest copied keyframe (sorted by offset then path). Paste target = first selected element (`selectedElements[0]`), requires a target to exist; keyframe time = clamp(playhead + offset, 0, element.duration) - NOTE: this uses playhead (timeline time) directly as an element-local time (command doesn't subtract element startTime; verify before copying, possible bug).
- `paste()` returns false if no entry/command; `copy()` notifies listeners (so `useEditor(e=>e.clipboard.hasEntry())` updates). Clipboard persists across projects within session.

## 7. Project model (copy of types)

```ts
// src/project/types.ts
type TBackground = { type: "color"; color: string } | { type: "blur"; blurIntensity: number };
interface TCanvasSize { width: number; height: number }
interface TProjectMetadata { id: string; name: string; thumbnail?: string; duration: MediaTime; createdAt: Date; updatedAt: Date }
interface TProjectSettings { fps: FrameRate; canvasSize: TCanvasSize; canvasSizeMode?: "preset"|"custom"; lastCustomCanvasSize?: TCanvasSize|null; originalCanvasSize?: TCanvasSize|null; background: TBackground }
interface TTimelineViewState { zoomLevel: number; scrollLeft: number; playheadTime: MediaTime }
interface TProject { metadata: TProjectMetadata; scenes: TScene[]; currentSceneId: string; settings: TProjectSettings; version: number; timelineViewState?: TTimelineViewState }
type TProjectSortKey = "createdAt"|"updatedAt"|"name"|"duration"; type TSortOrder="asc"|"desc"; type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
```
Defaults on create (project-manager.ts:82-106): one scene "Main scene" `isMain:true`; fps 30/1; canvas 1920x1080 (presets 1920x1080, 1080x1920, 1080x1080, 1440x1080); `canvasSizeMode:"preset"`, `lastCustomCanvasSize:null`, `originalCanvasSize:null`; background `{type:"color",color:"#000000"}`; `version=31`; no thumbnail; `DEFAULTS.timeline.viewState = {zoomLevel:1, scrollLeft:0, playheadTime:0}` used when none saved. Project duration = duration of main scene's tracks (`getProjectDurationFromScenes`).

```ts
// src/timeline/types.ts
type ElementRef = { trackId: string; elementId: string };
interface Bookmark { time: MediaTime; note?: string; color?: string; duration?: MediaTime }
interface TScene { id: string; name: string; isMain: boolean; tracks: SceneTracks; bookmarks: Bookmark[]; createdAt: Date; updatedAt: Date }
type TrackType = "video"|"text"|"audio"|"graphic"|"effect";
interface BaseTrack { id: string; name: string }
interface VideoTrack extends BaseTrack { type:"video"; elements:(VideoElement|ImageElement)[]; muted:boolean; hidden:boolean }
interface TextTrack extends BaseTrack { type:"text"; elements:TextElement[]; hidden:boolean }
interface AudioTrack extends BaseTrack { type:"audio"; elements:AudioElement[]; muted:boolean }
interface GraphicTrack extends BaseTrack { type:"graphic"; elements:(StickerElement|GraphicElement)[]; hidden:boolean }
interface EffectTrack extends BaseTrack { type:"effect"; elements:EffectElement[]; hidden:boolean }
type OverlayTrack = VideoTrack|TextTrack|GraphicTrack|EffectTrack;
interface SceneTracks { overlay: OverlayTrack[]; main: VideoTrack; audio: AudioTrack[] }   // display order top->bottom = overlay[0..], main, audio[0..]
interface RetimeConfig { rate: number; maintainPitch?: boolean }
interface BaseTimelineElement { id:string; name:string; duration:MediaTime; startTime:MediaTime; trimStart:MediaTime; trimEnd:MediaTime; sourceDuration?:MediaTime; animations?:ElementAnimations; params:ParamValues }
interface BaseAudioElement extends BaseTimelineElement { type:"audio"; buffer?:AudioBuffer; retime?:RetimeConfig }
interface UploadAudioElement extends BaseAudioElement { sourceType:"upload"; mediaId:string }
interface LibraryAudioElement extends BaseAudioElement { sourceType:"library"; sourceUrl:string }
interface VideoElement extends BaseTimelineElement { type:"video"; mediaId:string; isSourceAudioEnabled?:boolean; hidden?:boolean; retime?:RetimeConfig; effects?:Effect[]; masks?:Mask[] }
interface ImageElement extends BaseTimelineElement { type:"image"; mediaId:string; hidden?:boolean; effects?:Effect[]; masks?:Mask[] }
interface TextElement extends BaseTimelineElement { type:"text"; hidden?:boolean; effects?:Effect[] }
interface StickerElement extends BaseTimelineElement { type:"sticker"; stickerId:string; intrinsicWidth?:number; intrinsicHeight?:number; hidden?:boolean; effects?:Effect[] }
interface GraphicElement extends BaseTimelineElement { type:"graphic"; definitionId:string; hidden?:boolean; effects?:Effect[]; masks?:Mask[] }
interface EffectElement extends BaseTimelineElement { type:"effect"; effectType:string }
// Create* = Omit<X,"id">. MASKABLE = video,image,graphic. RETIMABLE = video,audio. VISUAL = video,image,text,sticker,graphic.
```
Notes: element visual properties live in `params: Record<string, number|string|boolean>` with dotted keys, e.g. text defaults (timeline/defaults.ts): content "Default text", fontSize 15, fontFamily "Arial", color "#ffffff", textAlign "center", fontWeight "normal", fontStyle "normal", textDecoration "none", letterSpacing 0, lineHeight 1.2, `background.{enabled,color,cornerRadius,paddingX,paddingY,offsetX,offsetY}`, `transform.{positionX,positionY,scaleX,scaleY,rotate}` (1,1,0,0,0), `opacity` 1, `blendMode` "normal". Audio uses `params.muted` and volume (dB; default volume 0). Element/track hidden/muted are separate flags. Main track name constant "Main Track" and main track rule: first element must start at 0 (`enforceMainTrackStart`).
```ts
// src/media/types.ts + services/storage/types.ts
type MediaType = "image"|"video"|"audio";
interface MediaAssetData { id:string; name:string; type:MediaType; size:number; lastModified:number; width?:number; height?:number; duration?:number; fps?:number; hasAudio?:boolean; ephemeral?:boolean; thumbnailUrl?:string }
interface MediaAsset extends Omit<MediaAssetData,"size"|"lastModified"> { file: File; url?: string }  // url = object URL created on load/import
// Serialized forms
type SerializedScene = Omit<TScene,"createdAt"|"updatedAt"> & { createdAt:string; updatedAt:string };
type SerializedProjectMetadata = Omit<TProjectMetadata,"createdAt"|"updatedAt"> & { createdAt:string; updatedAt:string };
type SerializedProject = Omit<TProject,"metadata"|"scenes"> & { metadata:SerializedProjectMetadata; scenes:SerializedScene[]; timelineViewState?:TTimelineViewState };
interface StorageAdapter<T> { get(key):Promise<T|null>; set({key,value}):Promise<void>; remove(key); list():Promise<string[]>; clear() }
```
Media assets are NOT stored inside the project record; element -> asset link is `mediaId`. Project record references no asset list. Media durations in `MediaAssetData.duration` are plain seconds (number), not MediaTime.
```ts
// animation (src/animation/types.ts) essentials
type AnimationPath = string  // e.g. "transform.positionX","opacity","volume","color","background.color|paddingX|paddingY|offsetX|offsetY|cornerRadius","params.<id>" (graphics),"effects.<effectId>.params.<key>"
type AnimationInterpolation = "linear"|"hold"|"bezier";
interface CurveHandle { dt: MediaTime; dv: number }
interface ScalarAnimationKey { id:string; time:MediaTime /*relative to element start*/; value:number; leftHandle?:CurveHandle; rightHandle?:CurveHandle; segmentToNext:"step"|"linear"|"bezier"; tangentMode:"auto"|"aligned"|"broken"|"flat" }
interface DiscreteAnimationKey { id:string; time:MediaTime; value:boolean|string }
interface ScalarChannel { keys:ScalarAnimationKey[]; extrapolation?:{before:"hold"|"linear"; after:"hold"|"linear"} }
interface DiscreteChannel { keys:DiscreteAnimationKey[] }
type ChannelData = ScalarChannel|DiscreteChannel | Record<string, ScalarChannel|DiscreteChannel|undefined>  // composite (e.g. colour = r,g,b,a linear RGBA)
interface ElementAnimations { [path:string]: ChannelData|undefined }
interface SelectedKeyframeRef { trackId:string; elementId:string; propertyPath:string; keyframeId:string }
interface ScalarCurveKeyframePatch { leftHandle?:CurveHandle|null; rightHandle?:CurveHandle|null; segmentToNext?:...; tangentMode?:... }
// effects (src/effects/types.ts)
interface Effect { id:string; type:string; params:ParamValues; enabled:boolean }
// masks (src/masks/types.ts): Mask = {id,type,params}. type: "split"|"cinematic-bars"|"rectangle"|"ellipse"|"heart"|"diamond"|"star"|"text"|"freeform"
interface BaseMaskParams { feather:number; inverted:boolean; strokeColor:string; strokeWidth:number; strokeAlign:"inside"|"center"|"outside" }
// Split: +centerX,centerY,rotation. Rectangle-like (cinematic-bars, rectangle, ellipse, heart, diamond, star): +centerX,centerY,width,height,rotation,scale. Text: +content,fontSize,fontFamily,fontWeight,fontStyle,textDecoration,letterSpacing,lineHeight,centerX,centerY,rotation,scale. Freeform: +path:FreeformPathPoint[],closed,centerX,centerY,rotation,scale.
// params (src/params/index.ts): type ParamValue = number|string|boolean; type ParamValues = Record<string,ParamValue>
// selection (src/selection/editor-selection.ts)
interface SelectedMaskPointSelection { trackId; elementId; maskId; pointIds:string[] }
interface EditorSelectionSnapshot { selectedElements:ElementRef[]; selectedKeyframes:SelectedKeyframeRef[]; keyframeSelectionAnchor:SelectedKeyframeRef|null; selectedMaskPoints:SelectedMaskPointSelection|null }
interface EditorSelectionPatch { /* same fields, all optional */ }
```
IDs: `generateUUID()` (`utils/id.ts`: crypto.randomUUID with manual v4 fallback) for projects, scenes, tracks, elements, assets, effects, keyframes.

## 8. Project list / create / rename / duplicate / delete flows (ProjectManager)

State: `active:TProject|null`, `savedProjects:TProjectMetadata[]`, `isLoading` (init true), `isInitialized`, `invalidProjectIds:Set`, `migrationState`, `exportState`. Subscribed via `useEditor`.
- **List** (`app/projects/page.tsx`): `loadAllProjects()` -> ensure migrations -> `storageService.loadAllProjectsMetadata()` (sorted updatedAt desc) -> `savedProjects`. Client-side filter (case-insensitive substring on name) + sort by `TProjectSortKey-order` (`getFilteredAndSortedProjects`). View mode grid/list, sort, persisted in `projects-view-mode`; multi-select with shift-range (`useProjectsStore.selectProjectRange`), bulk actions Duplicate/Delete.
- **Create**: `createNewProject({name})` builds the default project above, sets it active, clears media + initializes scenes, `storageService.saveProject`, prepends metadata to list, returns id; page then `router.push('/editor/<id>')`. On save failure: toast "Failed to save new project" and rethrow. (Name used by editor fallback: `"Untitled Project"`.)
- **Open**: `/editor/[project_id]` -> `EditorProvider`: init GPU renderer (`setDegraded(!gpuAvailable)` shows "open in Chrome" banner) -> `project.loadProject({id})`: pause autosave, ensure migrations, clear media + scenes, load record, set active, `scenes.initializeScenes` (adds a main scene if missing and force-marks dirty), `media.loadProjectMedia`, `loadFonts` for all font families used, generate thumbnail if missing (then save); finally `isLoading=false`, resume autosave. If error message includes "not found"/"does not exist" the provider auto-creates "Untitled Project" and `router.replace`s to it; otherwise shows error (surfaces `window.__wasmPanic` if set). While loading, keybindings disabled (`isLoadingProject`).
- **Rename**: `renameProject({id,name})` loads record from storage, updates `metadata.name`+`updatedAt`, saves, updates active+list; toast on failure. Editor header edits name inline (Enter commits, Escape cancels) and via rename dialog; `RenameProjectDialog` Enter submits.
- **Duplicate**: `duplicateProjects({ids})` (dedupes ids): loads each record; names: strip `^\((\d+)\)\s+(.+)$`; new name `"(N) <baseName>"` where N = max existing number for that base + 1 (starts at 1); new uuid, new createdAt/updatedAt, scenes/tracks copied as-is (SAME scene/track/element ids; ids only need to be unique per project); saves records, then copies every media asset (OPFS file + metadata) to the new project id; prepends to list; returns new ids; error toast + rethrow if any source missing.
- **Delete**: `deleteProjects({ids})`: for each, deleteProjectMedia (clears the project's media IndexedDB store and OPFS directory entries - note it clears but doesn't delete the DB/dir itself) + remove project record; filter list; if active project deleted -> clear active/media/scenes. Errors only logged. UI confirms with `DeleteProjectDialog`. Editor header delete -> then `router.push('/projects')`.
- **Exit** (`EditorHeader.handleExit`): `prepareExit()` (regenerate thumbnail from t=0 and `save.flush()`), `closeProject()` (active=null, clear media/scenes), `router.push('/projects')`. When `activeProject` is null the editor shows "Exiting project...".
- **Project info dialog** (`project/components/project-info-dialog.tsx`) shows metadata. `updateSettings({settings,pushHistory=true})` runs `UpdateProjectSettingsCommand`. `ratchetFpsForImportedMedia` raises project fps when a higher-fps video is imported (`getRaisedProjectFpsForImportedMedia`), not through history.
- **Timeline view state** persisted per project: `setTimelineViewState` (zoom, scrollLeft, playheadTime) from `use-timeline-zoom.ts` / `use-timeline-playhead.ts`; marks dirty + notifies.
- **Export**: `project.export({options})` delegates to `renderer.exportProject` with progress/cancel flags (`ExportState {isExporting, progress, result}`); out of scope here.

## 9. Server / DB role and env vars

- The editor works fully without the server. Server pieces in `apps/web` are marketing/site features only:
  - `src/db/{schema,index}.ts`: Drizzle + `postgres` driver; tables `users, sessions, accounts, verifications` (Better Auth schema, `usePlural`) with RLS enabled, plus `feedback(id text pk, message text not null, created_at)`. `drizzle.config.ts` points schema at `./src/lib/db/schema.ts` (stale path; actual file is `src/db/schema.ts`) and reads `.env.local` (or `.env.production`), out dir `migrations/` (one migration `0000_brainy_saracen.sql`), migrations table `drizzle_migrations`.
  - `src/auth/server.ts`: `betterAuth({drizzleAdapter(pg), emailAndPassword:{enabled:true}, user.deleteUser.enabled, rateLimit with Upstash Redis custom storage, baseURL NEXT_PUBLIC_SITE_URL, appName "OpenCut"})`, route `/api/auth/[...all]`. `src/auth/client.ts` exports `signIn, signUp, useSession`. Source comments: "we don't have any auth flows currently". No project ever references a user id. => Not needed for a local-first rebuild.
  - API routes: `/api/health`, `/api/feedback` (POST `{message}` zod 1..MAX_MESSAGE_LENGTH, rate-limited via `@/auth/rate-limit`, `submitFeedback` -> feedback table), `/api/sounds/search` (proxy to Freesound; params `q`, `type: songs|effects`, `page` 1..1000, `page_size` 1..150 default 20, `sort` downloads|rating|created|score, `min_rating` default 3, `commercial_only` default true; rate-limited). Sounds in the editor = Freesound results; saved sounds list in IndexedDB.
- Env (`src/env/web.ts`, zod-parsed at import - the app crashes at boot if any is missing): `NODE_ENV`, `ANALYZE?`, `NEXT_RUNTIME?`, `NEXT_PUBLIC_SITE_URL` (default http://localhost:3000), `NEXT_PUBLIC_MARBLE_API_URL` (blog CMS, https://api.marblecms.com), `DATABASE_URL` (postgres://), `BETTER_AUTH_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `MARBLE_WORKSPACE_KEY` (blog), `FREESOUND_CLIENT_ID`, `FREESOUND_API_KEY`. `.env.example` provides local values (postgres opencut/opencut@localhost:5432, redis REST at :8079). `docker-compose.yml`: postgres:17, redis:7, serverless-redis-http (SRH), web on :3100 with healthcheck `/api/health`.
- Minimum for a client-only editor clone: no server at all. Optional: Freesound proxy (needs `FREESOUND_*`) for sound library; feedback + auth are droppable. Build/deploy targets: Next 16 (`next dev --turbopack`), Cloudflare via `@opennextjs/cloudflare`; package manager bun; key deps: zustand 5, zod 4, mediabunny (media decode/encode), `opencut-wasm`, wavesurfer.js, soundtouchjs, @huggingface/transformers (transcription worker).

## 10. Items to verify / flagged oddities

1. `migrations/runner.ts` adapter call signatures mismatch (see section 5).
2. History not cleared on project switch; tracks-snapshot undo ignores which scene is active.
3. `MediaAssetData.fps/hasAudio` not persisted by `saveMediaAsset`.
4. Keyframe paste uses playhead time directly as element-local time.
5. `InsertElementCommand` first-element canvas/fps change is outside history (not undone).
6. Autosave failure path only logs; dirty flag already cleared, so a failed save is silently dropped until next change.
7. `docs/actions.md` and `drizzle.config.ts` reference stale `src/lib/...` paths.
8. `scenes.switchToScene` isn't a command and doesn't call markDirty directly (project `currentSceneId` is updated in memory; persisted at next save triggered by any scenes/timeline notify - `scenes.notify()` does trigger save since SaveManager subscribes to scenes).
9. `playback.dispatchSeekEvent/dispatchUpdateEvent` are empty stubs.
