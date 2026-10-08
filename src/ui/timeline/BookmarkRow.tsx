import { useRef, useState, type ReactNode } from "react";
import { moveBookmark, removeBookmark, updateBookmark } from "#/engine/commands";
import type { Bookmark } from "#/engine/model";
import { roundToFrame, snappedSeekTime, TICKS_PER_SECOND } from "#/engine/time";
import { getServices } from "#/app/services";
import { Button } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import { ColorField, Field } from "../primitives/fields";
import { interactionStore, type ControllerContext } from "./controllers";
import type { Viewport } from "./useViewport";
import { runEdit } from "../lib/edit";

const DEFAULT_COLOR = "#009dff";

function BookmarkEditor({ bookmark, onClose }: { bookmark: Bookmark; onClose: () => void }): ReactNode {
  const { editor } = getServices();
  const maxDuration = Math.max(0, editor.duration() - bookmark.time) / TICKS_PER_SECOND;
  return (
    <div style={{ width: 256, padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
      <Field label="Note">
        <input className="input input--sm" aria-label="Bookmark note" defaultValue={bookmark.note ?? ""}
          onBlur={(e) => runEdit(editor, updateBookmark(bookmark.time, { note: e.target.value || undefined }))} />
      </Field>
      <Field label="Color">
        <ColorField label="Bookmark color" value={bookmark.color ?? DEFAULT_COLOR} onChange={(c) => runEdit(editor, updateBookmark(bookmark.time, { color: c }))} />
      </Field>
      <Field label="Duration (seconds)">
        <input className="input input--sm" type="number" min={0} max={maxDuration} step={0.1} aria-label="Bookmark duration" defaultValue={(bookmark.duration ?? 0) / TICKS_PER_SECOND}
          onBlur={(e) => {
            const seconds = Math.min(maxDuration, Math.max(0, Number(e.target.value) || 0));
            runEdit(editor, updateBookmark(bookmark.time, { duration: Math.round(seconds * TICKS_PER_SECOND) as never }));
          }} />
      </Field>
      <Button variant="destructive" size="sm" onClick={() => { runEdit(editor, removeBookmark(bookmark.time)); onClose(); }}>Delete bookmark</Button>
    </div>
  );
}

export function BookmarkRow({ viewport, bookmarks, height, ctx }: { viewport: Viewport; bookmarks: Bookmark[]; height: number; ctx: ControllerContext }): ReactNode {
  const { editor } = getServices();
  const [editing, setEditing] = useState<number | null>(null);
  const anchors = useRef(new Map<number, HTMLButtonElement>());

  const startDrag = (e: React.PointerEvent, bookmark: Bookmark): void => {
    e.stopPropagation();
    const startX = e.clientX;
    let moved = false;
    let target = bookmark.time as number;
    const move = (ev: PointerEvent): void => {
      if (!moved && Math.abs(ev.clientX - startX) < 5) return;
      moved = true;
      interactionStore.set({ mode: "keyframe" });
      target = roundToFrame(Math.min(editor.duration(), ctx.viewport().clientXToTime(ev.clientX)), editor.fps());
      const btn = anchors.current.get(bookmark.time);
      if (btn) btn.style.left = `${viewport.timeToX(target)}px`;
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      interactionStore.set({ mode: "idle" });
      if (moved && target !== bookmark.time) runEdit(editor, moveBookmark(bookmark.time, target));
      else if (!moved) editor.playback.seek(snappedSeekTime(bookmark.time, editor.duration(), editor.fps()), performance.now());
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="timeline__bookmarks" style={{ width: viewport.width, height }}>
      {bookmarks.map((b) => {
        const left = viewport.timeToX(b.time);
        const spanWidth = b.duration ? viewport.timeToX(b.duration) : 0;
        return (
          <div key={b.time}>
            {spanWidth > 2 ? <div className="bookmark-span" style={{ left, width: spanWidth, background: b.color ?? DEFAULT_COLOR }} /> : null}
            <button
              ref={(el) => { if (el) anchors.current.set(b.time, el); else anchors.current.delete(b.time); }}
              type="button" className="bookmark" style={{ left, background: b.color ?? DEFAULT_COLOR }}
              aria-label={`Bookmark at ${(b.time / TICKS_PER_SECOND).toFixed(2)} seconds${b.note ? `: ${b.note}` : ""}`}
              onPointerDown={(e) => { if (e.button === 0) startDrag(e, b); }}
              onDoubleClick={() => setEditing(b.time)}
              onKeyDown={(e) => { if (e.key === "Enter") editor.playback.seek(b.time, performance.now()); }}
            />
          </div>
        );
      })}
      {editing !== null && bookmarks.find((b) => b.time === editing) ? (
        <Popover open onClose={() => setEditing(null)} anchor={{ x: 400, y: 160 }} label="Edit bookmark" className="popover--padded">
          <BookmarkEditor bookmark={bookmarks.find((b) => b.time === editing) as Bookmark} onClose={() => setEditing(null)} />
        </Popover>
      ) : null}
    </div>
  );
}
