import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  currentScene, removeTrackCommand, toggleBookmark, toggleSourceAudio, toggleTrackHidden, toggleTrackMuted, canToggleSourceAudio,
  pasteCommand, toggleElementsHidden, toggleElementsMuted, deleteElements, duplicateCommand,
} from "#/engine/commands";
import { listKeyframes } from "#/engine/animation";
import { canElementHaveAudio, canTrackBeHidden, canTrackHaveAudio, isVisualElement, type ElementRef, type TimelineElement } from "#/engine/model";
import { roundToFrame, TICKS_PER_SECOND } from "#/engine/time";
import {
  ZOOM_BUTTON_FACTOR, computeDropTarget, dropLineY, getElement, isSelected, totalDuration, wheelZoomFactor, type DropTarget,
} from "#/engine/timeline";
import { getServices } from "#/app/services";
import { invokeAction } from "#/app/actions";
import { insertPayload } from "#/app/insert";
import { uiStore, toggleExpanded } from "#/app/ui-state";
import { useEditorState, useSettings, useTracks } from "#/app/hooks";
import { Icon, type IconName } from "../icons";
import { Button } from "../primitives/Button";
import { ContextMenu, type ContextMenuState, type MenuEntry } from "../primitives/Menu";
import { Tooltip } from "../primitives/Tooltip";
import { toast } from "../primitives/toast";
import { currentDrag, hasFiles } from "../dnd";
import { ClipView } from "./ClipView";
import {
  interactionStore, startBackgroundGesture, startClipDrag, startKeyframeDrag, startResize, startScrub, type ControllerContext,
} from "./controllers";
import { BOOKMARK_ROW_HEIGHT, HEADER_HEIGHT, clipWindow, computeGeometry, intersectsWindow, pathLabel } from "./layout";
import { Playhead } from "./Playhead";
import { Ruler } from "./Ruler";
import { EasingPopover } from "./EasingPopover";
import { BookmarkRow } from "./BookmarkRow";
import { ScenesDialog } from "./ScenesDialog";
import { useViewport } from "./useViewport";
import { reportInsert, runEdit } from "../lib/edit";

const TRACK_ICON: Record<string, IconName> = { video: "video", text: "type", audio: "music", graphic: "shapes", effect: "wand" };

function ToolbarButton({ icon, label, onClick, disabled, active, shortcut }: {
  icon: IconName; label: string; onClick: () => void; disabled?: boolean; active?: boolean; shortcut?: string;
}): ReactNode {
  const button = (
    <Button variant={active ? "secondary" : "ghost"} size="icon" label={label} tooltip={false} aria-pressed={active} disabled={disabled} onClick={onClick} className={active ? "" : "btn--muted"}>
      <Icon name={icon} />
    </Button>
  );
  return (
    <Tooltip content={shortcut ? `${label} (${shortcut})` : label} delay={400}>
      {disabled ? <span style={{ display: "inline-flex" }}>{button}</span> : button}
    </Tooltip>
  );
}

export function Timeline(): ReactNode {
  const services = getServices();
  const { editor } = services;
  const tracks = useTracks();
  const settings = useSettings();
  const selection = useEditorState((s) => s.selection);
  const snappingEnabled = useEditorState((s) => s.snappingEnabled);
  const rippleEnabled = useEditorState((s) => s.rippleEnabled);
  const assets = useEditorState((s) => s.doc.assets);
  const scene = useEditorState((s) => currentScene(s.doc));
  const scenes = useEditorState((s) => s.doc.scenes);
  const expanded = uiStore.use((s) => s.expandedElements);
  const interactionMode = interactionStore.use((s) => s.mode);
  const snapTime = interactionStore.use((s) => s.snapTime);
  const dropLineIndex = interactionStore.use((s) => s.dropLineIndex);
  const selectionBox = interactionStore.use((s) => s.box);
  const duration = totalDuration(tracks);
  const viewport = useViewport(duration);
  const geometry = useMemo(() => computeGeometry({ tracks, expanded }), [tracks, expanded]);
  const sceneIsEmpty = geometry.boxes.every((box) => box.track.elements.length === 0);
  const [menu, setMenu] = useState<{ state: ContextMenuState; entries: MenuEntry[] } | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const dragDepth = useRef(0);
  const labelsInner = useRef<HTMLDivElement>(null);
  const [scenesOpen, setScenesOpen] = useState(false);

  const latest = useRef({ viewport, geometry });
  latest.current = { viewport, geometry };
  const ctx = useMemo<ControllerContext>(() => ({
    editor, viewport: () => latest.current.viewport, geometry: () => latest.current.geometry,
    scroll: () => latest.current.viewport.scrollRef.current, nowMs: () => performance.now(),
  }), [editor]);

  // Keep the track labels aligned with vertical scroll.
  useEffect(() => {
    const el = viewport.scrollRef.current;
    if (!el) return undefined;
    const onScroll = (): void => {
      if (labelsInner.current) labelsInner.current.style.transform = `translateY(${-el.scrollTop}px)`;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewport.scrollRef]);

  // Ctrl/Cmd+wheel zooms; Shift+wheel scrolls horizontally. Needs a non-passive listener to prevent page zoom.
  useEffect(() => {
    const el = viewport.scrollRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const vp = latest.current.viewport;
        vp.zoomBy(wheelZoomFactor(e.deltaY, e.deltaMode), { anchorClientX: e.clientX });
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const delta = e.shiftKey ? e.deltaY : e.deltaX;
        el.scrollLeft += Math.sign(delta) * Math.min(Math.abs(delta), 40);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [viewport.scrollRef]);

  const selectedKeyframeIds = useMemo(() => new Set(selection.keyframes.map((k) => k.keyframeId)), [selection.keyframes]);
  const selectedSet = useMemo(() => new Set(selection.elements.map((r) => `${r.trackId}/${r.elementId}`)), [selection.elements]);
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  const onClipPointerDown = useCallback((e: React.PointerEvent, ref: ElementRef): void => startClipDrag(ctx, e.nativeEvent, ref), [ctx]);
  const onClipResizeDown = useCallback((e: React.PointerEvent, ref: ElementRef, side: "left" | "right"): void => startResize(ctx, e.nativeEvent, ref, side), [ctx]);
  const onClipKeyframeDown = useCallback(
    (e: React.PointerEvent, ref: ElementRef, path: string, id: string): void => startKeyframeDrag(ctx, e.nativeEvent, ref, path, id), [ctx],
  );
  const onClipEffectsClick = useCallback((ref: ElementRef): void => {
    editor.setSelection({ elements: [ref], keyframes: [], keyframeAnchor: null });
    uiStore.set({ propertyTabs: { ...uiStore.get().propertyTabs, video: "effects", image: "effects" } });
  }, [editor]);

  // ---- Context menus ------------------------------------------------------------------------------------------

  const openClipMenu = useCallback((e: React.MouseEvent, ref: ElementRef): void => {
    e.preventDefault();
    const state = editor.getState();
    if (!isSelected(state.selection, ref)) editor.setSelection({ elements: [ref], keyframes: [], keyframeAnchor: null });
    const refs = editor.getState().selection.elements;
    const el = getElement(currentScene(state.doc).tracks, ref);
    if (!el) return;
    const many = refs.length > 1;
    const asset = "mediaId" in el ? state.doc.assets.find((a) => a.id === el.mediaId) : undefined;
    const entries: MenuEntry[] = [
      { label: "Split", icon: "scissors", shortcut: "S", onSelect: () => invokeAction("split") },
      { label: "Copy", icon: "copy", shortcut: "Ctrl C", onSelect: () => invokeAction("copy-selected") },
      { label: "Duplicate", icon: "copy", shortcut: "Ctrl D", onSelect: () => runEdit(editor, duplicateCommand(refs)) },
    ];
    if (canElementHaveAudio(el) && (el.type === "audio" || asset?.hasAudio !== false)) {
      const audible = refs.some((r) => getElement(currentScene(state.doc).tracks, r)?.params.muted !== true);
      entries.push({ label: audible ? "Mute" : "Unmute", icon: audible ? "volume-off" : "volume", onSelect: () => runEdit(editor, toggleElementsMuted(refs)) });
    }
    if (!many && canToggleSourceAudio(el, state.doc.assets)) {
      const separated = el.type === "video" && el.isSourceAudioEnabled === false;
      entries.push({ label: separated ? "Recover audio" : "Extract audio", icon: "scissors", onSelect: () => runEdit(editor, toggleSourceAudio(ref)) });
    }
    if (isVisualElement(el)) {
      const hidden = "hidden" in el && el.hidden === true;
      entries.push({ label: hidden ? "Show" : "Hide", icon: hidden ? "eye" : "eye-off", onSelect: () => runEdit(editor, toggleElementsHidden(refs)) });
    }
    if (listKeyframes(el.animations).length > 0) {
      const open = uiStore.get().expandedElements.has(el.id);
      entries.push({ label: open ? "Collapse keyframes" : "Expand keyframes", icon: "keyframe", onSelect: () => toggleExpanded(el.id) });
    }
    if (!many && "mediaId" in el) {
      entries.push({ label: "Reveal media", icon: "search", onSelect: () => uiStore.set({ assetTab: "media", revealMediaId: el.mediaId }) });
    }
    entries.push({ type: "separator" });
    entries.push({
      label: many ? `Delete ${refs.length} elements` : el.type === "text" ? "Delete text" : "Delete clip", icon: "trash", destructive: true,
      onSelect: () => runEdit(editor, deleteElements(refs)),
    });
    setMenu({ state: { x: e.clientX, y: e.clientY }, entries });
  }, [editor]);

  const openTrackMenu = (e: React.MouseEvent, trackId: string): void => {
    e.preventDefault();
    const track = [...tracks.overlay, tracks.main, ...tracks.audio].find((t) => t.id === trackId);
    if (!track) return;
    const entries: MenuEntry[] = [
      { label: "Paste elements", icon: "copy", disabled: !editor.getState().hasClipboard,
        onSelect: () => { const items = editor.clipboard; if (items) runEdit(editor, pasteCommand({ items, time: editor.playback.getState().currentTime })); } },
    ];
    if (canTrackHaveAudio(track)) {
      const muted = "muted" in track && track.muted;
      entries.push({ label: muted ? "Unmute track" : "Mute track", icon: muted ? "volume" : "volume-off", onSelect: () => runEdit(editor, toggleTrackMuted(trackId)) });
    }
    if (canTrackBeHidden(track)) {
      const hidden = "hidden" in track && track.hidden;
      entries.push({ label: hidden ? "Show track" : "Hide track", icon: hidden ? "eye" : "eye-off", onSelect: () => runEdit(editor, toggleTrackHidden(trackId)) });
    }
    if (trackId !== tracks.main.id) {
      entries.push({ type: "separator" }, { label: "Delete track", icon: "trash", destructive: true, onSelect: () => runEdit(editor, removeTrackCommand(trackId)) });
    }
    setMenu({ state: { x: e.clientX, y: e.clientY }, entries });
  };

  // ---- Drag and drop from panels / OS --------------------------------------------------------------------------

  const dropFor = (e: React.DragEvent): DropTarget | null => {
    const payload = currentDrag();
    const files = hasFiles(e);
    const el = viewport.scrollRef.current;
    if (!el) return null;
    const time = files && !payload ? editor.playback.getState().currentTime : viewport.clientXToTime(e.clientX);
    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top + el.scrollTop - HEADER_HEIGHT;
    let elementType: "video" | "audio" | "image" | "text" | "graphic" | "effect" = "video";
    let dur = TICKS_PER_SECOND * 5;
    let targetTypes: Array<"video" | "image" | "text" | "graphic"> | undefined;
    if (payload?.kind === "media") {
      elementType = payload.mediaType;
      dur = assetById.get(payload.assetId)?.duration ?? dur;
    } else if (payload?.kind === "text") elementType = "text";
    else if (payload?.kind === "graphic") elementType = "graphic";
    else if (payload?.kind === "effect") {
      elementType = "effect";
      targetTypes = ["video", "image", "text", "graphic"];
    }
    return computeDropTarget({
      tracks: currentScene(editor.getState().doc).tracks, elementType, mouseY: y, startTime: roundToFrame(time, editor.fps()), duration: dur,
      layout: geometry.layout, verticalDirection: null, targetElementTypes: targetTypes,
    });
  };

  const onDragOver = (e: React.DragEvent): void => {
    if (!currentDrag() && !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDrop(dropFor(e));
  };
  const onDragEnter = (e: React.DragEvent): void => {
    if (currentDrag() || hasFiles(e)) dragDepth.current++;
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDrop(null);
  };
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    dragDepth.current = 0;
    const target = dropFor(e);
    setDrop(null);
    const payload = currentDrag();
    if (payload) {
      const time = roundToFrame(viewport.clientXToTime(e.clientX), editor.fps());
      reportInsert(insertPayload({ editor, payload, startTime: time, target }));
      return;
    }
    const files = [...e.dataTransfer.files];
    if (files.length === 0) return;
    const outcome = await services.importFiles(files);
    for (const f of outcome.failures) toast.error(f.message);
    for (const asset of outcome.imported) {
      reportInsert(insertPayload({ editor, payload: { kind: "media", assetId: asset.id, mediaType: asset.type }, startTime: editor.playback.getState().currentTime, target: null }));
    }
    if (outcome.imported.length > 0) toast.success(`${outcome.imported.length} media ${outcome.imported.length === 1 ? "file" : "files"} added`);
  };

  const mountWindow = clipWindow({ scrollLeft: viewport.scrollLeft, viewportWidth: viewport.containerWidth });
  const contentHeight = HEADER_HEIGHT + geometry.totalHeight + 12;
  const snapX = snapTime !== null ? viewport.timeToX(snapTime) : null;
  const dropLine = drop?.isNewTrack ? HEADER_HEIGHT + dropLineY({ layout: geometry.layout, trackIndex: drop.trackIndex }) : null;
  const dragLine = interactionMode === "move" && dropLineIndex !== null ? HEADER_HEIGHT + dropLineY({ layout: geometry.layout, trackIndex: dropLineIndex }) : null;
  const hasKeyframeSelection = selection.keyframes.length > 0;
  const onlyElement = selection.elements.length === 1 ? getElement(tracks, selection.elements[0] as ElementRef) : undefined;
  const canSplitAudio = selection.elements.length === 1 && canToggleSourceAudio(onlyElement as TimelineElement | undefined, assets);
  const bookmarkAtPlayhead = scene.bookmarks.some((b) => b.time === editor.playback.getState().currentTime);

  return (
    <section className="timeline panel" aria-label="Timeline" data-tour="timeline">
      <div className="timeline__toolbar" role="toolbar" aria-label="Timeline tools">
        <div className="timeline__group">
          <ToolbarButton icon="scissors" label="Split" shortcut="S" onClick={() => invokeAction("split")} />
          <ToolbarButton icon="split-left" label="Split and remove left" shortcut="Q" onClick={() => invokeAction("split-left")} />
          <ToolbarButton icon="split-right" label="Split and remove right" shortcut="W" onClick={() => invokeAction("split-right")} />
          <ToolbarButton icon={onlyElement && onlyElement.type === "video" && onlyElement.isSourceAudioEnabled === false ? "link" : "unlink"}
            label={onlyElement && onlyElement.type === "video" && onlyElement.isSourceAudioEnabled === false ? "Recover audio" : "Extract audio"}
            disabled={!canSplitAudio} onClick={() => invokeAction("toggle-source-audio")} />
          <ToolbarButton icon="copy" label="Duplicate" shortcut="Ctrl D" disabled={selection.elements.length === 0} onClick={() => invokeAction("duplicate-selected")} />
          <ToolbarButton icon="trash" label="Delete" shortcut="Del" disabled={selection.elements.length === 0} onClick={() => invokeAction("delete-selected")} />
          <div className="timeline__divider" />
          <ToolbarButton icon="bookmark" label={bookmarkAtPlayhead ? "Remove bookmark" : "Add bookmark"} active={bookmarkAtPlayhead}
            onClick={() => runEdit(editor, toggleBookmark(editor.playback.getState().currentTime))} />
          <EasingPopover disabled={!hasKeyframeSelection} />
        </div>
        <div className="scene-select" role="group" aria-label="Scene">
          <span className="scene-select__name">{scene.name || "No scene"}</span>
          <Tooltip content="Scenes" delay={400}><button type="button" aria-label="Scenes" onClick={() => setScenesOpen(true)}><Icon name="layers" /></button></Tooltip>
        </div>
        <div className="timeline__group">
          <ToolbarButton icon="magnet" label="Auto snapping" shortcut="N" active={snappingEnabled} onClick={() => invokeAction("toggle-snapping")} />
          <ToolbarButton icon="ripple" label="Ripple editing" active={rippleEnabled} onClick={() => invokeAction("toggle-ripple-editing")} />
          <div className="timeline__divider" />
          <ToolbarButton icon="zoom-out" label="Zoom out" onClick={() => viewport.zoomBy(1 / ZOOM_BUTTON_FACTOR)} />
          <input type="range" className="slider" style={{ width: 112 }} min={0} max={1} step={0.005} aria-label="Timeline zoom"
            value={Math.min(1, Math.max(0, viewport.slider))} onChange={(e) => viewport.setSlider(Number(e.target.value))} />
          <ToolbarButton icon="zoom-in" label="Zoom in" onClick={() => viewport.zoomBy(ZOOM_BUTTON_FACTOR)} />
        </div>
      </div>

      <div className="timeline__body">
        <div className="timeline__labels" aria-label="Tracks">
          <div style={{ height: HEADER_HEIGHT, borderBottom: "1px solid transparent" }} />
          <div ref={labelsInner} style={{ position: "relative", height: geometry.totalHeight }}>
            {geometry.boxes.map((box) => {
              const hasSelected = (box.track.elements as TimelineElement[]).some((el) => selectedSet.has(`${box.track.id}/${el.id}`));
              const muted = "muted" in box.track && box.track.muted;
              const hidden = "hidden" in box.track && box.track.hidden;
              return (
                <div key={box.track.id}>
                  <div className="track-label" data-selected={hasSelected} style={{ top: box.top, height: box.baseHeight }} onContextMenu={(e) => openTrackMenu(e, box.track.id)}>
                    {canTrackHaveAudio(box.track) ? (
                      <Tooltip content={muted ? "Unmute track" : "Mute track"} side="right" delay={400}>
                        <button type="button" data-off={muted} aria-label={muted ? "Unmute track" : "Mute track"} aria-pressed={muted}
                          onClick={() => runEdit(editor, toggleTrackMuted(box.track.id))}><Icon name={muted ? "volume-off" : "volume"} /></button>
                      </Tooltip>
                    ) : null}
                    {canTrackBeHidden(box.track) ? (
                      <Tooltip content={hidden ? "Show track" : "Hide track"} side="right" delay={400}>
                        <button type="button" data-off={hidden} aria-label={hidden ? "Show track" : "Hide track"} aria-pressed={hidden}
                          onClick={() => runEdit(editor, toggleTrackHidden(box.track.id))}><Icon name={hidden ? "eye-off" : "eye"} /></button>
                      </Tooltip>
                    ) : null}
                    <span aria-label={`${box.track.type} track`} style={{ color: "var(--muted-foreground)", display: "grid" }}><Icon name={TRACK_ICON[box.track.type] ?? "video"} /></span>
                  </div>
                  {box.lanes.map((path, i) => (
                    <div key={path} className="track-label" style={{ top: box.top + box.baseHeight + i * 20, height: 20, background: "color-mix(in srgb, var(--muted) 50%, transparent)", justifyContent: "flex-start", fontSize: "var(--text-xs)", color: "var(--muted-foreground)" }}>
                      {pathLabel(path)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div
          ref={viewport.scrollRef} className="timeline__scroll scrollbar-thin" tabIndex={-1}
          onDragOver={onDragOver} onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDrop={(e) => void onDrop(e)}
        >
          <div className="timeline__content" style={{ width: viewport.width, height: contentHeight, minHeight: "100%" }}>
            <Ruler zoom={viewport.zoom} fps={settings.fps} scrollLeft={viewport.scrollLeft} viewportWidth={viewport.containerWidth} maxTime={Math.max(duration, (viewport.width / (50 * viewport.zoom)) * TICKS_PER_SECOND)}
              width={viewport.width} onPointerDown={(e) => { if (e.button === 0) startScrub(ctx, e.nativeEvent, { fromRuler: true }); }} />
            <BookmarkRow viewport={viewport} bookmarks={scene.bookmarks} height={BOOKMARK_ROW_HEIGHT} ctx={ctx} />
            <div
              data-track-area style={{ position: "absolute", top: HEADER_HEIGHT, left: 0, right: 0, bottom: 0 }}
              onPointerDown={(e) => { if (e.button === 0 && e.target === e.currentTarget) startBackgroundGesture(ctx, e.nativeEvent); }}
            >
              {geometry.boxes.map((box) => {
                const elements = box.track.elements as TimelineElement[];
                const hasSelected = elements.some((el) => selectedSet.has(`${box.track.id}/${el.id}`));
                return (
                  <div
                    key={box.track.id} className="track-row" data-selected={hasSelected} data-empty={elements.length === 0}
                    style={{ top: box.top, height: box.height }} data-track-id={box.track.id}
                    onPointerDown={(e) => { if (e.button === 0 && e.target === e.currentTarget) startBackgroundGesture(ctx, e.nativeEvent); }}
                    onContextMenu={(e) => { if (e.target === e.currentTarget) openTrackMenu(e, box.track.id); }}
                  />
                );
              })}
              {sceneIsEmpty ? (
                <div className="timeline__empty" data-testid="timeline-empty-hint">
                  <Icon name="film" size={18} />
                  <span>Drag a clip here, or press <kbd>+</kbd> on a media tile</span>
                </div>
              ) : null}
              {geometry.boxes.flatMap((box) => (box.track.elements as TimelineElement[]).flatMap((element) => {
                const selected = selectedSet.has(`${box.track.id}/${element.id}`);
                if (!selected && !intersectsWindow({ startPx: viewport.timeToX(element.startTime), endPx: viewport.timeToX(element.startTime + element.duration), window: mountWindow })) return [];
                const asset = "mediaId" in element ? assetById.get(element.mediaId) : undefined;
                return [(
                  <ClipView
                    key={element.id} element={element} trackId={box.track.id} box={box} selected={selected}
                    selectedKeyframeIds={selected ? selectedKeyframeIds : EMPTY_SET} asset={asset} zoom={viewport.zoom}
                    expanded={expanded.has(element.id)} dropTarget={drop?.targetElement?.elementId === element.id}
                    onPointerDown={onClipPointerDown} onResizeDown={onClipResizeDown} onKeyframeDown={onClipKeyframeDown}
                    onContextMenu={openClipMenu} onEffectsClick={onClipEffectsClick}
                  />
                )];
              }))}
            </div>
            {selectionBox ? (
              <div className="selection-box" style={{ left: selectionBox.left, top: selectionBox.top + HEADER_HEIGHT, width: selectionBox.right - selectionBox.left, height: selectionBox.bottom - selectionBox.top }} />
            ) : null}
            {snapX !== null && snappingEnabled ? <div className="snap-indicator" style={{ left: snapX - 1 }} /> : null}
            {dropLine !== null ? <div className="drop-line" style={{ top: dropLine - 1 }} /> : null}
            {dragLine !== null ? <div className="drop-line" style={{ top: dragLine - 1 }} /> : null}
            <Playhead viewport={viewport} height={contentHeight}
              onKnobDown={(e) => { e.preventDefault(); e.stopPropagation(); startScrub(ctx, e.nativeEvent, { fromRuler: false }); }}
              onKey={(e) => {
                const frame = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                if (!frame) return;
                e.preventDefault();
                e.stopPropagation();
                invokeAction(frame > 0 ? "frame-step-forward" : "frame-step-backward");
              }} />
          </div>
        </div>
      </div>
      <ContextMenu state={menu?.state ?? null} entries={menu?.entries ?? []} onClose={() => setMenu(null)} width={256} />
      <ScenesDialog open={scenesOpen} onClose={() => setScenesOpen(false)} scenes={scenes} currentId={scene.id} />
    </section>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();
