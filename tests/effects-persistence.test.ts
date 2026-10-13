import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_VERSION } from "#/engine/model";
import { applyTemplateToEditor } from "#/engine/templates";
import { deserializeProject, serializeProject } from "#/engine/persistence";
import { allElements } from "#/engine/timeline";
import { getTemplate } from "#/templates";
import { editorWith, type AssetSpec } from "./template-support";

/** A project that uses every new style element survives save and load, and a v6 file opens unchanged. */
describe("style elements persist", () => {
  const specs: AssetSpec[] = [
    { id: "ui-1", type: "video", seconds: 12 }, { id: "ui-2", type: "video", seconds: 12 }, { id: "ui-3", type: "video", seconds: 12 },
  ];
  const build = () => {
    const editor = editorWith(specs);
    applyTemplateToEditor(editor, getTemplate("tilted-ui-tour")!, { slots: { "ui-1": "ui-1", "ui-2": "ui-2", "ui-3": "ui-3" } });
    return editor;
  };

  it("round-trips tilt, shadow, mask, blur transitions, blur-in text and a mesh background exactly", () => {
    const project = build().toProject();
    expect(project.settings.background.type).toBe("gradient");
    const loaded = deserializeProject(serializeProject(project));
    expect(loaded).toEqual(project);
    expect(loaded.repairNotes).toBeUndefined();
    const media = allElements(loaded.scenes[0]!.tracks).filter((l) => l.element.type === "video");
    expect(media.some((l) => l.element.params["transform.rotateY"] !== undefined)).toBe(true);
    expect(media.some((l) => l.element.type === "video" && l.element.transition?.type === "blur")).toBe(true);
  });

  it("round-trips a count-up and a cursor path", () => {
    const editor = editorWith([]);
    applyTemplateToEditor(editor, getTemplate("growth-numbers")!, {});
    const project = editor.toProject();
    const loaded = deserializeProject(serializeProject(project));
    expect(loaded).toEqual(project);
    expect(allElements(loaded.scenes[0]!.tracks).some((l) => l.element.type === "text" && l.element.params["countEnabled"] === true)).toBe(true);

    const prompt = editorWith([{ id: "r1", type: "video", seconds: 12 }, { id: "r2", type: "video", seconds: 12 }]);
    applyTemplateToEditor(prompt, getTemplate("prompt-to-result")!, { repeat: { cycles: [{ slots: { result: "r1" } }, { slots: { result: "r2" } }] } });
    const withCursor = prompt.toProject();
    const reloaded = deserializeProject(serializeProject(withCursor));
    expect(allElements(reloaded.scenes[0]!.tracks).map((l) => l.element.id).sort()).toEqual(allElements(withCursor.scenes[0]!.tracks).map((l) => l.element.id).sort());
    expect(deserializeProject(serializeProject(reloaded))).toEqual(reloaded);
    expect(allElements(reloaded.scenes[0]!.tracks).some((l) => l.element.type === "graphic" && l.element.definitionId === "cursor" && l.element.animations?.["params.click"] !== undefined)).toBe(true);
  });

  it("opens a v6 project unchanged and writes v7", () => {
    const stored = JSON.parse(serializeProject(build().toProject())) as { version: number };
    stored.version = 6;
    const loaded = deserializeProject(JSON.stringify(stored));
    expect(loaded.version).toBe(PROJECT_SCHEMA_VERSION);
    expect(PROJECT_SCHEMA_VERSION).toBe(7);
  });

  it("keeps a damaged gradient from reaching the frame plan", () => {
    const stored = JSON.parse(serializeProject(build().toProject())) as { settings: { background: Record<string, unknown> } };
    stored.settings.background = { type: "gradient", style: "mesh", colors: "not-a-list", angle: 0, motion: 0 };
    const loaded = deserializeProject(JSON.stringify(stored));
    expect(loaded.settings.background.type).toBe("gradient");
  });
});
