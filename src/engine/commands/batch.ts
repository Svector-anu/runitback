import type { SelectionState } from "#/engine/model";
import type { Command, CommandContext, CommandResult, EditorDocument } from "./types";

/** Runs commands in order as a single history entry. */
export function batch(label: string, commands: ReadonlyArray<Command>): Command {
  return {
    label,
    run(doc: EditorDocument, ctx: CommandContext): CommandResult {
      let current = doc;
      let selection: SelectionState | undefined;
      let sceneId: string | undefined;
      for (const command of commands) {
        const result = command.run(current, ctx);
        current = result.doc;
        if (result.selection) selection = result.selection;
        sceneId = result.sceneId ?? sceneId;
      }
      return { doc: current, selection, sceneId };
    },
  };
}
