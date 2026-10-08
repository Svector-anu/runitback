import type { Command } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import type { InsertOutcome } from "#/app/insert";
import { toast } from "../primitives/toast";

/** Runs an edit; a rejected command leaves the project untouched and tells the user why. Returns whether it applied. */
export function runEdit(editor: Editor, command: Command): boolean {
  const result = editor.tryExecute(command);
  if (!result.ok) toast.error("That change could not be applied", result.error.message);
  return result.ok;
}

/** Commits the active gesture preview; a stale plan is reported instead of throwing out of a pointer handler. */
export function commitEdit(editor: Editor): boolean {
  let result;
  try {
    result = editor.tryCommitPreview();
  } catch (error) {
    toast.error("That change could not be applied", error instanceof Error ? error.message : undefined);
    return false;
  }
  if (!result) return false;
  if (!result.ok) toast.error("That change could not be applied", result.error.message);
  return result.ok;
}

/** Reports a failed insert (drop, double click, "+" button) and returns whether the clip was added. */
export function reportInsert(outcome: InsertOutcome): boolean {
  if (!outcome.ok) toast.error("Could not add that item to the timeline", outcome.message);
  return outcome.ok;
}
