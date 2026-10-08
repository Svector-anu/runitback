import { mediaTime, type FrameRate, type MediaTime } from "#/engine/time";
import {
  EMPTY_SELECTION, EngineError, type ElementRef, type IdGenerator, type MediaAssetInfo, type Project, type ProjectMetadata,
  type SceneTracks, type SelectionState, type TimelineViewState,
} from "#/engine/model";
import { allElements, assertNoNewViolations, copyElements, type ClipboardItem } from "#/engine/timeline";
import {
  CommandManager, currentScene, withAsset, withAssetList, type Command, type EditorDocument, type HistoryCheckpoint, type HistorySnapshot,
} from "#/engine/commands";
import { Playback } from "./playback";
import { documentDuration, projectDuration } from "./selectors";

export interface EditorState {
  /** Null until a project is loaded. */
  meta: ProjectMetadata | null;
  doc: EditorDocument;
  /** Transient result of an in-progress gesture; never persisted and not in history. */
  preview: EditorDocument | null;
  selection: SelectionState;
  viewState: TimelineViewState;
  rippleEnabled: boolean;
  snappingEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasClipboard: boolean;
  /** Increments with every committed change; the save manager keys off it. */
  revision: number;
}

export interface EditorDeps {
  newId: IdGenerator;
  now: () => string;
}

type Listener = () => void;

interface Transaction {
  label: string;
  checkpoint: HistoryCheckpoint;
  doc: EditorDocument;
  selection: SelectionState;
  /** Steps undone inside this transaction that redo may still reapply. */
  redoable: number;
}

/** Outcome of `tryExecute`: the editor is unchanged when `ok` is false. */
export type ExecuteResult = { ok: true } | { ok: false; error: EngineError };

export const EMPTY_DOCUMENT_ID = "__empty__";

function emptyDocument(): EditorDocument {
  const tracks: SceneTracks = {
    overlay: [], audio: [],
    main: { id: EMPTY_DOCUMENT_ID, name: "Main Track", type: "video", elements: [], muted: false, hidden: false },
  };
  return {
    scenes: [{ id: EMPTY_DOCUMENT_ID, name: "", isMain: true, tracks, bookmarks: [], createdAt: "", updatedAt: "" }],
    currentSceneId: EMPTY_DOCUMENT_ID,
    settings: {
      fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, canvasSizeMode: "preset",
      originalCanvasSize: null, background: { type: "color", color: "#000000" },
    },
    assets: [],
  };
}

const DEFAULT_VIEW: TimelineViewState = { zoomLevel: 1, scrollLeft: 0, playheadTime: mediaTime(0) };

/**
 * The editor facade. All document changes go through `execute`; gestures use `preview` then `commitPreview`.
 * It owns no DOM, timers, or storage so it can run headless.
 */
export class Editor {
  private state: EditorState;
  private listeners = new Set<Listener>();
  private committedListeners = new Set<() => void>();
  private history: CommandManager;
  private clipboardItems: ClipboardItem[] | null = null;
  private previewCommand: Command | null = null;
  private transactions: Transaction[] = [];
  readonly playback: Playback;

  constructor(private readonly deps: EditorDeps) {
    this.history = new CommandManager(deps);
    this.state = {
      meta: null, doc: emptyDocument(), preview: null, selection: EMPTY_SELECTION, viewState: DEFAULT_VIEW,
      rippleEnabled: false, snappingEnabled: true, canUndo: false, canRedo: false, hasClipboard: false, revision: 0,
    };
    this.playback = new Playback({
      getDuration: () => documentDuration(this.effectiveDoc()),
      getFps: () => this.effectiveDoc().settings.fps,
    });
  }

  // ---- State access ------------------------------------------------------------------------------------------

  getState = (): EditorState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fires after every committed document change (not for previews, selection, or playback). */
  onCommitted(listener: () => void): () => void {
    this.committedListeners.add(listener);
    return () => this.committedListeners.delete(listener);
  }

  get newId(): IdGenerator { return this.deps.newId; }

  effectiveDoc(): EditorDocument { return this.state.preview ?? this.state.doc; }

  get hasProject(): boolean { return this.state.meta !== null; }

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /**
   * Applies a snapshot as the committed state. Derived values are computed first so a snapshot that cannot be
   * read (and therefore could not be rendered) is refused before any state changes; if reconciling the playhead
   * still throws, the previous state is restored.
   */
  private commit(snapshot: HistorySnapshot, extra: Partial<EditorState> = {}): void {
    documentDuration(snapshot.doc);
    projectDuration(snapshot.doc);
    const previous = this.state;
    const previousPreviewCommand = this.previewCommand;
    this.previewCommand = null;
    try {
      this.set({
        doc: snapshot.doc, selection: snapshot.selection, preview: null,
        canUndo: this.history.canUndo, canRedo: this.history.canRedo, revision: this.state.revision + 1, ...extra,
      });
      this.playback.reconcile();
    } catch (error) {
      this.state = previous;
      this.previewCommand = previousPreviewCommand;
      for (const l of this.listeners) l();
      throw error;
    }
    for (const l of this.committedListeners) l();
  }

  // ---- Project lifecycle -------------------------------------------------------------------------------------

  load(input: { project: Project; assets: MediaAssetInfo[] }): void {
    const { project } = input;
    this.history.clear();
    this.transactions = [];
    this.previewCommand = null;
    this.playback.pause();
    this.set({
      meta: project.metadata,
      doc: { scenes: project.scenes, currentSceneId: project.currentSceneId, settings: project.settings, assets: input.assets },
      preview: null, selection: EMPTY_SELECTION, viewState: project.timelineViewState,
      canUndo: false, canRedo: false, revision: 0,
    });
    this.playback.seek(project.timelineViewState.playheadTime);
  }

  close(): void {
    this.history.clear();
    this.transactions = [];
    this.previewCommand = null;
    this.playback.pause();
    this.set({
      meta: null, doc: emptyDocument(), preview: null, selection: EMPTY_SELECTION, viewState: DEFAULT_VIEW,
      canUndo: false, canRedo: false, revision: 0,
    });
    this.playback.seek(mediaTime(0));
  }

  /** Serializable snapshot of the open project (metadata duration and timestamps refreshed). */
  toProject(): Project {
    const { meta, doc, viewState } = this.state;
    if (!meta) throw new Error("No project is open");
    return {
      metadata: { ...meta, duration: projectDuration(doc), updatedAt: this.deps.now() },
      scenes: doc.scenes, currentSceneId: doc.currentSceneId, settings: doc.settings,
      timelineViewState: { ...viewState, playheadTime: this.playback.getState().currentTime },
      assetIds: this.retainedAssetIds(),
      version: 1,
    };
  }

  /** Every asset id that must survive: registered, used by any scene, or restorable by undo/redo. */
  private retainedAssetIds(): string[] {
    const ids = new Set(this.state.doc.assets.map((a) => a.id));
    for (const asset of this.history.retainedAssets()) ids.add(asset.id);
    for (const scene of this.state.doc.scenes) {
      for (const { element } of allElements(scene.tracks)) {
        if ("mediaId" in element) ids.add(element.mediaId);
      }
    }
    return [...ids];
  }

  updateMetadata(patch: Partial<ProjectMetadata>): void {
    if (!this.state.meta) return;
    this.set({ meta: { ...this.state.meta, ...patch }, revision: this.state.revision + 1 });
    for (const l of this.committedListeners) l();
  }

  setViewState(patch: Partial<TimelineViewState>): void {
    this.set({ viewState: { ...this.state.viewState, ...patch } });
    for (const l of this.committedListeners) l();
  }

  // ---- Commands & history ------------------------------------------------------------------------------------

  /**
   * Runs a command and commits the result. Throws an `EngineError` (`InvalidInputError`, `InvariantViolationError`)
   * when the command is malformed or would break a document invariant; the document, selection and history are
   * then exactly as before the call.
   */
  execute(command: Command): void {
    const recorded = this.history.length;
    const snapshot = this.history.execute({
      command, state: { doc: this.state.doc, selection: this.state.selection }, rippleEnabled: this.state.rippleEnabled,
    });
    try {
      this.commit(snapshot);
    } catch (error) {
      if (this.history.length > recorded) this.history.discardLast();
      throw error;
    }
    for (const tx of this.transactions) tx.redoable = 0;
    if (this.transactions.length === 0) this.history.trim();
  }

  /** Like `execute`, but reports a rejected edit as a value instead of throwing. Other errors still throw. */
  tryExecute(command: Command): ExecuteResult {
    try {
      this.execute(command);
      return { ok: true };
    } catch (error) {
      if (error instanceof EngineError) return { ok: false, error };
      throw error;
    }
  }

  /** Inside a transaction, undo/redo only reach steps taken inside the innermost transaction. */
  undo(): boolean {
    this.discardPreview();
    const tx = this.transactions[this.transactions.length - 1];
    if (tx && this.history.length <= tx.checkpoint.length) return false;
    const snapshot = this.history.undo(this.state.doc);
    if (!snapshot) return false;
    if (tx) tx.redoable++;
    this.commit(snapshot);
    return true;
  }

  redo(): boolean {
    this.discardPreview();
    const tx = this.transactions[this.transactions.length - 1];
    if (tx && tx.redoable <= 0) return false;
    const snapshot = this.history.redo(this.state.doc);
    if (!snapshot) return false;
    if (tx) tx.redoable--;
    this.commit(snapshot);
    return true;
  }

  // ---- Transactions ------------------------------------------------------------------------------------------

  get inTransaction(): boolean { return this.transactions.length > 0; }

  /**
   * Starts a group of edits that ends up as ONE undo step. Calls nest: only the outermost commit collapses history,
   * an inner rollback reverts to where the inner transaction began.
   */
  beginTransaction(label: string): void {
    if (this.transactions.length === 0) this.discardPreview();
    this.transactions.push({
      label, checkpoint: this.history.checkpoint(), doc: this.state.doc, selection: this.state.selection, redoable: 0,
    });
  }

  commitTransaction(): void {
    const tx = this.transactions.pop();
    if (!tx) throw new Error("commitTransaction without beginTransaction");
    if (this.transactions.length > 0) return;
    this.history.collapseTo({
      checkpoint: tx.checkpoint, label: tx.label, selectionBefore: tx.selection, selectionAfter: this.state.selection,
    });
    this.set({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
  }

  /** Restores the document, selection and history exactly as they were at the matching beginTransaction. */
  rollbackTransaction(): void {
    const tx = this.transactions.pop();
    if (!tx) throw new Error("rollbackTransaction without beginTransaction");
    this.discardPreview();
    this.history.rollbackTo(tx.checkpoint);
    if (this.state.doc === tx.doc && this.state.selection === tx.selection) {
      this.set({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
      return;
    }
    const known = new Set(this.state.doc.assets.map((a) => a.id));
    const assets = [...this.state.doc.assets, ...tx.doc.assets.filter((a) => !known.has(a.id))];
    this.commit({ doc: withAssetList(tx.doc, assets), selection: tx.selection });
  }

  /** Evaluate a command against the committed document for live feedback without recording anything. */
  /**
   * Returns false (and falls back to the committed document) when the command cannot be evaluated, e.g. a drag
   * plan computed before the document changed underneath it. Never throws.
   */
  preview(command: Command): boolean {
    try {
      const result = command.run(this.state.doc, { newId: this.deps.newId, now: this.deps.now });
      assertNoNewViolations({ before: this.state.doc, after: result.doc, label: command.label });
      this.previewCommand = command;
      this.set({ preview: result.doc });
      return true;
    } catch {
      this.discardPreview();
      return false;
    }
  }

  /** Commits the active preview as one undo step. Returns false when it is no longer valid; never throws. */
  commitPreview(): boolean {
    const command = this.previewCommand;
    if (!command) return false;
    this.previewCommand = null;
    this.set({ preview: null });
    try {
      this.execute(command);
      return true;
    } catch {
      return false;
    }
  }

  discardPreview(): void {
    if (!this.previewCommand && !this.state.preview) return;
    this.previewCommand = null;
    this.set({ preview: null });
  }

  get isPreviewing(): boolean { return this.state.preview !== null; }

  /** Switching scene is navigation, not an edit: it is not undoable but it is saved. */
  switchScene(sceneId: string): void {
    const doc = this.state.doc;
    if (doc.currentSceneId === sceneId || !doc.scenes.some((s) => s.id === sceneId)) return;
    this.discardPreview();
    this.commit({ doc: { ...doc, currentSceneId: sceneId }, selection: EMPTY_SELECTION });
  }

  // ---- Assets ------------------------------------------------------------------------------------------------

  registerAsset(asset: MediaAssetInfo): void {
    this.commit({ doc: withAsset(this.state.doc, asset), selection: this.state.selection });
  }

  getAsset(id: string): MediaAssetInfo | undefined {
    return this.effectiveDoc().assets.find((a) => a.id === id);
  }

  // ---- Selection ---------------------------------------------------------------------------------------------

  setSelection(selection: SelectionState): void {
    this.set({ selection });
  }

  clearSelection(): void {
    if (this.state.selection !== EMPTY_SELECTION) this.set({ selection: EMPTY_SELECTION });
  }

  // ---- Clipboard ---------------------------------------------------------------------------------------------

  copySelection(): boolean {
    const tracks = currentScene(this.state.doc).tracks;
    const items = copyElements({ tracks, refs: this.state.selection.elements });
    if (items.length === 0) return false;
    this.clipboardItems = items;
    this.set({ hasClipboard: true });
    return true;
  }

  get clipboard(): ReadonlyArray<ClipboardItem> | null { return this.clipboardItems; }

  // ---- Toggles -----------------------------------------------------------------------------------------------

  setRippleEnabled(rippleEnabled: boolean): void { this.set({ rippleEnabled }); }
  setSnappingEnabled(snappingEnabled: boolean): void { this.set({ snappingEnabled }); }

  // ---- Convenience reads -------------------------------------------------------------------------------------

  tracks(): SceneTracks { return currentScene(this.effectiveDoc()).tracks; }
  fps(): FrameRate { return this.effectiveDoc().settings.fps; }
  duration(): MediaTime { return documentDuration(this.effectiveDoc()); }
  selectionRefs(): ElementRef[] { return this.state.selection.elements; }
}
