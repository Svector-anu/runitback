import { EMPTY_SELECTION, type IdGenerator, type SelectionState } from "#/engine/model";
import { pruneEmptyTracks, rippleEdit, pruneSelection } from "#/engine/timeline";
import type { Command, CommandContext, EditorDocument } from "./types";

export interface HistoryEntry {
  label: string;
  before: EditorDocument;
  after: EditorDocument;
  sceneId: string;
  selectionBefore: SelectionState;
  selectionAfter: SelectionState;
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
    if (tracks === afterScene.tracks) return after;
    return { ...after, scenes: after.scenes.map((s) => (s.id === sceneId ? { ...s, tracks } : s)) };
  }

  execute(input: { command: Command; state: HistorySnapshot; rippleEnabled: boolean }): HistorySnapshot {
    const { command, state } = input;
    const result = command.run(state.doc, this.ctx);
    const sceneId = result.sceneId ?? state.doc.currentSceneId;
    const doc = this.settle(state.doc, result.doc, sceneId, input.rippleEnabled);
    const scene = doc.scenes.find((s) => s.id === sceneId) ?? doc.scenes.find((s) => s.id === doc.currentSceneId);
    const wanted = result.selection ?? state.selection;
    const selection = scene ? pruneSelection(wanted, scene.tracks) : EMPTY_SELECTION;
    if (doc !== state.doc) {
      this.history.push({ label: command.label, before: state.doc, after: doc, sceneId, selectionBefore: state.selection, selectionAfter: selection });
      this.redoStack = [];
    }
    return { doc, selection };
  }

  /** Records an already-applied change (preview gestures commit this way). */
  push(entry: HistoryEntry): void {
    this.history.push(entry);
    this.redoStack = [];
  }

  undo(): HistorySnapshot | null {
    const entry = this.history.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    return { doc: this.restore(entry.before, entry.sceneId), selection: entry.selectionBefore };
  }

  redo(): HistorySnapshot | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.history.push(entry);
    return { doc: this.restore(entry.after, entry.sceneId), selection: entry.selectionAfter };
  }

  /** Undo/redo return to the scene the step edited so the change is visible, falling back to main. */
  private restore(doc: EditorDocument, sceneId: string): EditorDocument {
    const target = doc.scenes.find((s) => s.id === sceneId) ?? doc.scenes.find((s) => s.isMain) ?? doc.scenes[0];
    return target && target.id !== doc.currentSceneId ? { ...doc, currentSceneId: target.id } : doc;
  }
}

