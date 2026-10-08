// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertElement } from "#/engine/commands";
import { loadFont } from "#/platform/fonts";
import { ErrorBoundary } from "#/ui/primitives/ErrorBoundary";
import { NumberField } from "#/ui/primitives/fields";
import { Toaster } from "#/ui/primitives/toast";
import { runEdit } from "#/ui/lib/edit";
import { trackPointerGesture } from "#/ui/lib/pointer-gesture";
import { TEXT_FIELDS, TRANSFORM_FIELDS } from "#/ui/properties/defs";
import { image, makeEditor } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.head.innerHTML = "";
  vi.useRealTimers();
});

const render = (node: ReactNode): void => { act(() => root.render(node)); };

describe("ErrorBoundary (a)", () => {
  it("shows a friendly screen with collapsed details instead of a blank page, and Reload project recovers", () => {
    const state = { broken: true };
    const Bomb = (): ReactNode => {
      if (state.broken) throw new Error("kaboom in the timeline");
      return <p>editor is back</p>;
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ErrorBoundary scope="the editor"><Bomb /></ErrorBoundary>);
    quiet.mockRestore();

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Something went wrong in the editor");
    const details = host.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("kaboom in the timeline");
    const reload = [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload project");
    expect(reload).toBeDefined();

    state.broken = false;
    act(() => reload?.click());
    expect(host.textContent).toContain("editor is back");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("runEdit surfaces engine rejections through the toast system (a)", () => {
  it("toasts the error message and leaves the document untouched", () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: image("a", 0, 5), placement: { mode: "auto" } }));
    const trackId = editor.getState().doc.scenes[0]!.tracks.main.id;
    const before = editor.getState().doc;
    render(<Toaster />);
    let applied = true;
    act(() => { applied = runEdit(editor, insertElement({ element: image("a", 0, 5), placement: { mode: "explicit", trackId } })); });
    expect(applied).toBe(false);
    expect(editor.getState().doc).toBe(before);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("That change could not be applied");
    expect(host.querySelector(".toast__description")?.textContent).toMatch(/already exists/);
  });
});

describe("inspector number fields (f)", () => {
  it("every numeric transform and text field has finite min and max", () => {
    for (const field of [...TRANSFORM_FIELDS, ...TEXT_FIELDS]) {
      if (field.type !== "number") continue;
      expect(Number.isFinite(field.min), `${field.key} min`).toBe(true);
      expect(Number.isFinite(field.max), `${field.key} max`).toBe(true);
    }
  });

  it("typing 1e9 into Font size commits the maximum, and a non-finite expression commits nothing", () => {
    const fontSize = TEXT_FIELDS.find((f) => f.key === "fontSize");
    if (fontSize?.type !== "number") throw new Error("fontSize field missing");
    const commits: number[] = [];
    render(<NumberField label="Font size" value={15} min={fontSize.min} max={fontSize.max} step={fontSize.step} onCommit={(v) => commits.push(v)} />);
    const input = host.querySelector("input") as HTMLInputElement;
    const type = (text: string): void => {
      act(() => { input.focus(); });
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      act(() => { setter?.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
      act(() => { input.blur(); });
    };
    type("1e9");
    expect(commits).toEqual([500]);
    type("1e999");
    expect(commits).toEqual([500]);
  });
});

describe("pointer gestures (P1-9)", () => {
  const pointer = (type: string): Event => new Event(type, { bubbles: true });

  it("pointercancel ends the gesture exactly once and later events are ignored", () => {
    const calls: string[] = [];
    trackPointerGesture({ move: () => calls.push("move"), up: () => calls.push("up"), cancel: () => calls.push("cancel") });
    window.dispatchEvent(pointer("pointercancel"));
    window.dispatchEvent(pointer("pointermove"));
    window.dispatchEvent(pointer("pointerup"));
    window.dispatchEvent(pointer("blur"));
    expect(calls).toEqual(["cancel"]);
  });

  it("window blur cancels too", () => {
    const cancel = vi.fn();
    trackPointerGesture({ move: vi.fn(), up: vi.fn(), cancel });
    window.dispatchEvent(pointer("blur"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("coalesces moves to one per frame and flushes the last one before pointerup", () => {
    const seen: string[] = [];
    trackPointerGesture({ move: (e) => seen.push(`move:${(e as unknown as { n: number }).n}`), up: () => seen.push("up"), cancel: vi.fn() });
    for (let n = 1; n <= 5; n++) window.dispatchEvent(Object.assign(pointer("pointermove"), { n }));
    expect(seen).toEqual([]);
    window.dispatchEvent(pointer("pointerup"));
    expect(seen).toEqual(["move:5", "up"]);
  });

  it("the returned stop function removes every listener without calling handlers", () => {
    const handlers = { move: vi.fn(), up: vi.fn(), cancel: vi.fn() };
    const stop = trackPointerGesture(handlers);
    stop();
    window.dispatchEvent(pointer("pointermove"));
    window.dispatchEvent(pointer("pointerup"));
    window.dispatchEvent(pointer("pointercancel"));
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.up).not.toHaveBeenCalled();
    expect(handlers.cancel).not.toHaveBeenCalled();
  });
});

describe("fonts never block rendering (P1-16)", () => {
  let appended: HTMLLinkElement[];
  beforeEach(() => {
    appended = [];
    vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => { appended.push(node as unknown as HTMLLinkElement); return node; });
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves false after the timeout when Google Fonts never answers, and retries on the next call", async () => {
    vi.useFakeTimers();
    const first = loadFont("Offline Test Font", 500);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.href).toContain("family=Offline+Test+Font");
    await vi.advanceTimersByTimeAsync(499);
    let settled = false;
    void first.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(first).resolves.toBe(false);

    const second = loadFont("Offline Test Font", 500);
    expect(appended).toHaveLength(2);
    appended[1]?.onerror?.(new Event("error"));
    await expect(second).resolves.toBe(false);
  });

  it("never makes a request for names that are not plain family names", async () => {
    for (const family of ['x"; evil', "a/b", "", "x".repeat(65), "Robert'); DROP", "a\nb"]) {
      await expect(loadFont(family)).resolves.toBe(false);
    }
    expect(appended).toHaveLength(0);
  });

  it("system fonts need no request", async () => {
    await expect(loadFont("Arial")).resolves.toBe(false);
    expect(appended).toHaveLength(0);
  });
});
