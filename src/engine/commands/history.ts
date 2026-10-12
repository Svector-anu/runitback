import { EMPTY_SELECTION, InvalidInputError, type IdGenerator, type MediaAssetInfo, type SelectionState } from "#/engine/model";
import { assertNoNewViolations, pruneEmptyTracks, reconcileTransitions, rippleEdit, pruneSelection } from "#/engine/timeline";
import { withAssetList } from "./project";
import type { Command, CommandContext, CommandResult, EditorDocument } from "./types";

export interface HistoryEntry {
  label: string;
  before: EditorDocument;
  after: EditorDocument;
  sceneId: string;
  selectionBefore: SelectionState;
  selectionAfter: SelectionState;
  /**
   * Assets this step removed. Undo re-adds them and redo removes them again; every other change to the asset list
   * (imports) is deliberately outside history, so undo can never lose an imported asset.
   */
  removedAssets: MediaAssetInfo[];
}

/** Maximum number of undo steps kept; older ones are forgotten. */
export const MAX_HISTORY_ENTRIES = 500;

function removedBetween(before: EditorDocument, after: EditorDocument): MediaAssetInfo[] {
  const kept = new Set(after.assets.map((a) => a.id));
  return before.assets.filter((a) => !kept.has(a.id));
}

function mergeAssets(current: ReadonlyArray<MediaAssetInfo>, extra: ReadonlyArray<MediaAssetInfo>): MediaAssetInfo[] {
  const known = new Set(current.map((a) => a.id));
  return [...current, ...extra.filter((a) => !known.has(a.id))];
}

/** A position in history that a transaction can collapse back to or roll back to. */
export interface HistoryCheckpoint {
  length: number;
  redo: HistoryEntry[];
}

export interface HistorySnapshot {
  doc: EditorDocument;
  selection: SelectionState;
}

/** Runs commands with the shared edit rules (ripple, empty-track pruning) and records whole-document undo steps. */
export class CommandManager {
  private history: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(private readonly deps: { newId: IdGenerator; now: () => string }) {}

  private get ctx(): CommandContext {
    return { newId: this.deps.newId, now: this.deps.now };
  }

  get canUndo(): boolean { return this.history.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null { return this.history[this.history.length - 1]?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack[this.redoStack.length - 1]?.label ?? null; }

  clear(): void {
    this.history = [];
    this.redoStack = [];
  }

  /** Applies the shared post-edit rules to the scene a command touched. */
  private settle(before: EditorDocument, after: EditorDocument, sceneId: string, rippleEnabled: boolean): EditorDocument {
    const beforeScene = before.scenes.find((s) => s.id === sceneId);
    const afterScene = after.scenes.find((s) => s.id === sceneId);
    if (!beforeScene || !afterScene) return after;
    let tracks = afterScene.tracks;
    if (rippleEnabled) tracks = rippleEdit({ before: beforeScene.tracks, after: tracks });
    tracks = pruneEmptyTracks(tracks);
    tracks = reconcileTransitions(tracks);
    if (tracks === afterScene.tracks) return after;
    return { ...after, scenes: after.scenes.map((s) => (s.id === sceneId ? { ...s, tracks } : s)) };
  }

  /** Time arithmetic throws RangeError on NaN or fractional ticks; at this boundary that is a malformed argument. */
  private run(command: Command, doc: EditorDocument): CommandResult {
    try {
      return command.run(doc, this.ctx);
    } catch (error) {
      if (error instanceof RangeError) throw new InvalidInputError(`${command.label}: ${error.message}`);
      throw error;
    }
  }

  execute(input: { command: Command; state: HistorySnapshot; rippleEnabled: boolean }): HistorySnapshot {
    const { command, state } = input;
    const result = this.run(command, state.doc);
    const sceneId = result.sceneId ?? state.doc.currentSceneId;
    const doc = this.settle(state.doc, result.doc, sceneId, input.rippleEnabled);
    assertNoNewViolations({ before: state.doc, after: doc, label: command.label });
    const scene = doc.scenes.find((s) => s.id === sceneId) ?? doc.scenes.find((s) => s.id === doc.currentSceneId);
    const wanted = result.selection ?? state.selection;
    const selection = scene ? pruneSelection(wanted, scene.tracks) : EMPTY_SELECTION;
    if (doc !== state.doc) {
      this.history.push({ label: command.label, before: state.doc, after: doc, sceneId, selectionBefore: state.selection, selectionAfter: selection, removedAssets: removedBetween(state.doc, doc) });
      this.redoStack = [];
    }
    return { doc, selection };
  }

  checkpoint(): HistoryCheckpoint {
    return { length: this.history.length, redo: [...this.redoStack] };
  }

  get length(): number { return this.history.length; }

  /**
   * Replaces every entry recorded since `checkpoint` with one entry spanning the whole range.
   * With no entries the redo stack is restored (a change that was undone inside the transaction leaves no trace).
   */
  collapseTo(input: { checkpoint: HistoryCheckpoint; label: string; selectionBefore: SelectionState; selectionAfter: SelectionState }): void {
    const created = this.history.splice(input.checkpoint.length);
    const first = created[0];
    const last = created[created.length - 1];
    if (!first || !last) {
      this.redoStack = [...input.checkpoint.redo];
      return;
    }
    this.history.push({
      label: input.label, before: first.before, after: last.after, sceneId: last.sceneId,
      selectionBefore: input.selectionBefore, selectionAfter: input.selectionAfter,
      removedAssets: mergeAssets([], created.flatMap((e) => e.removedAssets)),
    });
    this.redoStack = [];
  }

  /** Forgets everything recorded since `checkpoint` and restores the redo stack of that moment. */
  rollbackTo(checkpoint: HistoryCheckpoint): void {
    this.history.length = Math.min(this.history.length, checkpoint.length);
    this.redoStack = [...checkpoint.redo];
  }

  /** Records an already-applied change (preview gestures commit this way). */
  push(entry: HistoryEntry): void {
    this.history.push(entry);
    this.redoStack = [];
  }

  /** Drops the newest step without applying anything (used when its commit failed after being recorded). */
  discardLast(): void {
    this.history.pop();
  }

  /** Forgets the oldest steps beyond `max`. Callers must not hold checkpoints (no open transaction). */
  trim(max = MAX_HISTORY_ENTRIES): void {
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
  }

  /** Assets that an undo or redo could still bring back; their stored bytes must be kept. */
  retainedAssets(): MediaAssetInfo[] {
    return mergeAssets([], [...this.history, ...this.redoStack].flatMap((e) => e.removedAssets));
  }

  undo(current: EditorDocument): HistorySnapshot | null {
    const entry = this.history.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    const doc = this.restore(entry.before, entry.sceneId);
    return { doc: withAssetList(doc, mergeAssets(current.assets, entry.removedAssets)), selection: entry.selectionBefore };
  }

  redo(current: EditorDocument): HistorySnapshot | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.history.push(entry);
    const removed = new Set(entry.removedAssets.map((a) => a.id));
    const doc = this.restore(entry.after, entry.sceneId);
    return { doc: withAssetList(doc, current.assets.filter((a) => !removed.has(a.id))), selection: entry.selectionAfter };
  }

  /** Undo/redo return to the scene the step edited so the change is visible, falling back to main. */
  private restore(doc: EditorDocument, sceneId: string): EditorDocument {
    const target = doc.scenes.find((s) => s.id === sceneId) ?? doc.scenes.find((s) => s.isMain) ?? doc.scenes[0];
    return target && target.id !== doc.currentSceneId ? { ...doc, currentSceneId: target.id } : doc;
  }
}

