import { memo, useRef, useState, type ReactNode } from "react";
import { listKeyframes } from "#/engine/animation";
import { dbToVolumeLine, volumeLineToDb } from "#/engine/audio";
import { updateElements } from "#/engine/commands";
import {
  PARAM, numberParam, type ElementRef, type MediaAssetInfo, type TimelineElement,
} from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { Icon } from "../icons";
import { getServices } from "#/app/services";
import { THUMBNAIL_ASPECT, type TrackBox } from "./layout";
import { Waveform } from "./Waveform";
import { commitEdit } from "../lib/edit";

export interface ClipViewProps {
  element: TimelineElement;
  trackId: string;
  box: TrackBox;
  selected: boolean;
  selectedKeyframeIds: ReadonlySet<string>;
  asset: MediaAssetInfo | undefined;
  zoom: number;
  expanded: boolean;
  dropTarget: boolean;
  onPointerDown(e: React.PointerEvent, ref: ElementRef): void;
  onResizeDown(e: React.PointerEvent, ref: ElementRef, side: "left" | "right"): void;
  onKeyframeDown(e: React.PointerEvent, ref: ElementRef, path: string, keyframeId: string): void;
  onContextMenu(e: React.MouseEvent, ref: ElementRef): void;
  onEffectsClick(ref: ElementRef): void;
}

const pxPerTick = (zoom: number): number => (50 * zoom) / TICKS_PER_SECOND;

function VolumeLine({ element, refValue, height }: { element: TimelineElement; refValue: ElementRef; height: number }): ReactNode {
  const { editor } = getServices();
  const [tip, setTip] = useState<{ x: number; y: number; db: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  if (listKeyframes(element.animations).some((k) => k.path === PARAM.volume)) return null;
  const db = numberParam(element.params, PARAM.volume, 0);
  const top = dbToVolumeLine(db) * height;

  const onDown = (e: React.PointerEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    const parent = box.current?.parentElement;
    if (!parent) return;
    editor.setSelection({ elements: [refValue], keyframes: [], keyframeAnchor: null });
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let last = db;
    const apply = (ev: PointerEvent): void => {
      const rect = parent.getBoundingClientRect();
      last = volumeLineToDb((ev.clientY - rect.top) / rect.height);
      editor.preview(updateElements([{ ref: refValue, patch: { params: { volume: last } } }], "Change volume"));
      setTip({ x: ev.clientX + 12, y: ev.clientY - 28, db: last });
    };
    const up = (): void => {
      target.removeEventListener("pointermove", apply);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      setTip(null);
      if (last !== db) commitEdit(editor);
      else editor.discardPreview();
    };
    const cancel = (): void => {
      target.removeEventListener("pointermove", apply);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      setTip(null);
      editor.discardPreview();
    };
    target.addEventListener("pointermove", apply);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
    apply(e.nativeEvent);
  };
  return (
    <>
      <div ref={box} className="clip__volume" data-active={tip !== null} style={{ top }} title="Drag to adjust clip volume" onPointerDown={onDown} />
      {tip ? <div className="clip__volume-tip">{tip.db.toFixed(1)} dB</div> : null}
    </>
  );
}

function ClipViewImpl(props: ClipViewProps): ReactNode {
  const { element, trackId, box, selected, asset, zoom } = props;
  const ref: ElementRef = { trackId, elementId: element.id };
  const left = element.startTime * pxPerTick(zoom);
  const width = Math.max(2, element.duration * pxPerTick(zoom));
  const height = box.baseHeight;
  const hidden = "hidden" in element && element.hidden === true;
  const keyframes = listKeyframes(element.animations);
  const effects = "effects" in element ? (element.effects ?? []) : [];

  let className = "clip";
  let style: React.CSSProperties = { left, width, top: box.top, height };
  let body: ReactNode = null;

  switch (element.type) {
    case "video":
    case "image": {
      className += " clip--video";
      if (asset?.thumbnail) {
        style = { ...style, backgroundImage: `url(${JSON.stringify(asset.thumbnail)})`, backgroundSize: `${height * THUMBNAIL_ASPECT}px ${height}px` };
      }
      body = (
        <div className="clip__header">
          <span className="clip__name truncate">{element.name}</span>
          {effects.length > 0 ? (
            <button type="button" className="btn btn--text" aria-label="Show effects" style={{ pointerEvents: "auto", color: "rgba(255,255,255,0.85)" }}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => props.onEffectsClick(ref)}><Icon name="wand" size={12} /></button>
          ) : null}
        </div>
      );
      break;
    }
    case "audio": {
      className += " clip--audio";
      const assetSeconds = (asset?.duration ?? element.sourceDuration ?? element.duration) / TICKS_PER_SECOND;
      body = (
        <>
          <div className="clip__header"><span className="clip__name truncate">{element.name}</span></div>
          <Waveform mediaId={element.mediaId} assetSeconds={assetSeconds} trimStartSeconds={element.trimStart / TICKS_PER_SECOND}
            sourceSeconds={element.duration / TICKS_PER_SECOND} rate={element.retime?.rate ?? 1} width={width} height={height} />
          <VolumeLine element={element} refValue={ref} height={height} />
        </>
      );
      break;
    }
    case "text":
      className += " clip--text";
      body = <div className="clip__label truncate">{String(element.params.content ?? "")}</div>;
      break;
    case "graphic":
      className += " clip--graphic";
      body = <div className="clip__label truncate"><Icon name="shapes" size={14} /> {element.name}</div>;
      break;
    case "effect":
      className += " clip--effect";
      body = <div className="clip__label truncate"><Icon name="wand" size={14} /> {element.name}</div>;
      break;
  }

  const showKeyframes = selected && keyframes.length > 0 && width >= 40;
  const grouped = new Map<number, typeof keyframes>();
  for (const k of keyframes) grouped.set(k.time, [...(grouped.get(k.time) ?? []), k]);

  return (
    <>
      <div
        className={className} style={style} data-selected={selected} data-hidden={hidden} data-drop-target={props.dropTarget}
        data-clip-id={element.id} data-start={element.startTime} data-duration={element.duration} data-track-id={trackId} role="button" tabIndex={0} aria-pressed={selected}
        aria-label={`${element.type} ${element.name}${selected ? ", selected" : ""}`}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); props.onPointerDown(e, ref); } }}
        onContextMenu={(e) => props.onContextMenu(e, ref)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); getServices().editor.setSelection({ elements: [ref], keyframes: [], keyframeAnchor: null }); } }}
      >
        {body}
        {selected ? (
          <>
            <button type="button" tabIndex={-1} aria-label="Left resize handle" className="clip__resize clip__resize--left"
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); props.onResizeDown(e, ref, "left"); }} onClick={(e) => e.stopPropagation()} />
            <button type="button" tabIndex={-1} aria-label="Right resize handle" className="clip__resize clip__resize--right"
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); props.onResizeDown(e, ref, "right"); }} onClick={(e) => e.stopPropagation()} />
          </>
        ) : null}
        {showKeyframes ? [...grouped.entries()].map(([time, list]) => {
          const first = list[0];
          if (!first) return null;
          const isSel = list.some((k) => props.selectedKeyframeIds.has(k.id));
          return (
            <button key={time} type="button" className="clip__keyframe" data-selected={isSel} aria-label={`Keyframe at ${(time / TICKS_PER_SECOND).toFixed(2)}s`}
              style={{ left: time * pxPerTick(zoom) }}
              onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); props.onKeyframeDown(e, ref, first.path, first.id); }}>
              <Icon name="keyframe" size={14} />
            </button>
          );
        }) : null}
      </div>
      {props.expanded ? box.lanes.map((path, i) => {
        const laneKeys = keyframes.filter((k) => k.path === path);
        return (
          <div key={path} className="kf-lane" style={{ top: box.top + box.baseHeight + i * 20, left, width }}>
            {laneKeys.map((k) => (
              <button key={k.id} type="button" className="clip__keyframe" style={{ left: k.time * pxPerTick(zoom), bottom: 3 }}
                data-selected={props.selectedKeyframeIds.has(k.id)} aria-label={`${path} keyframe`}
                onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); props.onKeyframeDown(e, ref, path, k.id); }}>
                <Icon name="keyframe" size={14} />
              </button>
            ))}
          </div>
        );
      }) : null}
    </>
  );
}

function sameBox(a: TrackBox, b: TrackBox): boolean {
  return a.top === b.top && a.baseHeight === b.baseHeight && a.lanes.length === b.lanes.length && a.lanes.every((lane, i) => lane === b.lanes[i]);
}

/** Geometry boxes are rebuilt on every document change; a clip only cares about the numbers it draws with. */
function propsEqual(prev: ClipViewProps, next: ClipViewProps): boolean {
  return prev.element === next.element && prev.trackId === next.trackId && prev.selected === next.selected
    && prev.selectedKeyframeIds === next.selectedKeyframeIds && prev.asset === next.asset && prev.zoom === next.zoom
    && prev.expanded === next.expanded && prev.dropTarget === next.dropTarget && sameBox(prev.box, next.box)
    && prev.onPointerDown === next.onPointerDown && prev.onResizeDown === next.onResizeDown
    && prev.onKeyframeDown === next.onKeyframeDown && prev.onContextMenu === next.onContextMenu && prev.onEffectsClick === next.onEffectsClick;
}

export const ClipView = memo(ClipViewImpl, propsEqual);
