import { describe, expect, it } from "vitest";
import { projectHasNoElements, type Scene } from "#/engine/model";
import { makeEditor, tracksWith, video } from "./helpers";

const scene = (tracks: ReturnType<typeof tracksWith>): Scene => ({ ...makeEditor().project.scenes[0], tracks } as Scene);

describe("projectHasNoElements", () => {
  it("is true for a fresh project", () => {
    const { project } = makeEditor();
    expect(projectHasNoElements(project.scenes)).toBe(true);
  });

  it("looks at every scene, so a blank second scene does not make a used project look new", () => {
    const used = scene(tracksWith({ main: [video("a", 0, 2)] }));
    const blank = scene(tracksWith({}));
    expect(projectHasNoElements([used, blank])).toBe(false);
    expect(projectHasNoElements([blank])).toBe(true);
  });
});
