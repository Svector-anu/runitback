import { callTool, type AgentToolRegistry } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import type { ResolvedFixture } from "./types";

/**
 * Puts the fixtures that declare `placeAt` on the timeline, in declaration order, through the same tools the agent uses.
 * By default the editor is then reloaded from its own snapshot so the setup edits are not in the undo history.
 */
export async function placeInitialTimeline(input: {
  editor: Editor; tools: AgentToolRegistry; fixtures: ReadonlyArray<ResolvedFixture>;
  /** Reload the editor from its own snapshot so setup is not undoable. Skip it when driving a live app. Default true. */
  resetHistory?: boolean;
}): Promise<void> {
  const { editor, tools } = input;
  const ctx = { editor, nowMs: () => 0 };
  for (const fixture of input.fixtures) {
    if (fixture.spec.placeAt === undefined) continue;
    const result = await callTool({ tools, name: "insert_media", args: { assetId: fixture.assetId, start: fixture.spec.placeAt }, ctx });
    if (!result.ok) throw new Error(`Could not place fixture "${fixture.spec.id}": ${result.error}`);
  }
  if (input.resetHistory === false) return;
  const assets: MediaAssetInfo[] = [...editor.getState().doc.assets];
  editor.load({ project: editor.toProject(), assets });
}
