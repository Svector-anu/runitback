import { useEffect, useRef, type ReactNode } from "react";
import { currentScene } from "#/engine/commands";
import { numberParam, stringParam, PARAM, type ElementRef } from "#/engine/model";
import { getElement } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { paramEditCommand } from "#/app/param-edit";
import { scaledFontSize } from "#/render/text";
import type { ElementBounds } from "#/render/bounds";
import { canvasToScreen, type PreviewView } from "./view";

/** In-place text editing: a transparent textarea over the clip; the canvas underneath shows the live result. */
export function TextEditOverlay({ refValue, bounds, view, onDone }: { refValue: ElementRef; bounds: ElementBounds; view: PreviewView; onDone: () => void }): ReactNode {
  const { editor } = getServices();
  const ref = useRef<HTMLTextAreaElement>(null);
  const element = getElement(currentScene(editor.getState().doc).tracks, refValue);
  const finished = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    editor.playback.pause();
  }, [editor]);

  if (!element || element.type !== "text") return null;
  const params = element.params;
  const fontPx = scaledFontSize(numberParam(params, PARAM.fontSize, 15), view.canvas.height) * view.scale;
  const c = canvasToScreen(view, bounds.cx, bounds.cy);
  const width = Math.max(40, bounds.width * view.scale);
  const height = Math.max(fontPx * 1.2, bounds.height * view.scale);

  const preview = (content: string): void => {
    editor.preview(paramEditCommand({ element, ref: refValue, values: { [PARAM.content]: content }, playhead: editor.playback.getState().currentTime, label: "Edit text" }));
  };
  const finish = (commit: boolean): void => {
    if (finished.current) return;
    finished.current = true;
    if (commit && editor.isPreviewing) editor.commitPreview();
    else editor.discardPreview();
    onDone();
  };

  return (
    <textarea
      ref={ref} aria-label="Edit text" defaultValue={stringParam(params, PARAM.content, "")} spellCheck={false}
      onChange={(e) => preview(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") finish(false); }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "absolute", left: c.x, top: c.y, width, height, transform: `translate(-50%, -50%) rotate(${bounds.rotationDegrees}deg)`,
        background: "transparent", border: "1px solid var(--primary)", outline: "none", resize: "none", overflow: "hidden", padding: 0,
        color: "transparent", caretColor: stringParam(params, PARAM.color, "#ffffff"), textAlign: stringParam(params, PARAM.textAlign, "center") as "left",
        fontSize: fontPx, lineHeight: numberParam(params, PARAM.lineHeight, 1.2), fontFamily: `"${stringParam(params, PARAM.fontFamily, "Arial")}", sans-serif`,
        fontWeight: stringParam(params, PARAM.fontWeight, "normal"), fontStyle: stringParam(params, PARAM.fontStyle, "normal"),
      }}
    />
  );
}
