import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { closeSheet, toggleSheet, uiStore, type SheetTab } from "#/app/ui-state";
import { useAgentSession } from "#/app/agent/instance";
import { useSettings } from "#/app/hooks";
import { Icon, type IconName } from "../icons";
import { AgentPanel } from "../agent/AgentPanel";
import { AssetsPanel } from "../assets/AssetsPanel";
import { PreviewPanel } from "../preview/PreviewPanel";
import { PropertiesPanel } from "../properties/PropertiesPanel";
import { Timeline } from "../timeline/Timeline";
import { usePinchZoom } from "./use-pinch-zoom";

const TABS: ReadonlyArray<{ id: SheetTab; label: string; icon: IconName }> = [
  { id: "assets", label: "Assets", icon: "folder" },
  { id: "properties", label: "Properties", icon: "sliders" },
  { id: "agent", label: "Agent", icon: "wand" },
];

const DISMISS_DRAG_PX = 72;

function SheetBody({ tab }: { tab: SheetTab }): ReactNode {
  return tab === "assets" ? <AssetsPanel /> : tab === "properties" ? <PropertiesPanel /> : <AgentPanel />;
}

/** Drag the grabber down to dismiss; a tap on it dismisses too. */
function useSheetDrag(sheet: React.RefObject<HTMLDivElement | null>): { onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void } {
  return {
    onPointerDown: (e) => {
      const el = sheet.current;
      if (!el) return;
      const startY = e.clientY;
      let offset = 0;
      const move = (m: globalThis.PointerEvent): void => {
        offset = Math.max(0, m.clientY - startY);
        el.style.transform = `translateY(${offset}px)`;
        el.style.transition = "none";
      };
      const end = (): void => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        el.style.transform = "";
        el.style.transition = "";
        if (offset >= DISMISS_DRAG_PX) closeSheet();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
  };
}

function Sheet({ tab }: { tab: SheetTab }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag(ref);
  const label = TABS.find((t) => t.id === tab)?.label ?? "";
  return (
    <div ref={ref} id="mobile-sheet" className="mobile-sheet" role="tabpanel" aria-label={label} data-testid="mobile-sheet" data-tab={tab}>
      <button type="button" className="mobile-sheet__grabber" aria-label={`Close ${label} panel`} onClick={closeSheet} {...drag}>
        <span className="mobile-sheet__bar" aria-hidden="true" />
        <span className="mobile-sheet__title" aria-hidden="true">{label}</span>
        <Icon name="x" size={18} />
      </button>
      <div className="mobile-sheet__body"><SheetBody tab={tab} /></div>
    </div>
  );
}

function TabBar({ open }: { open: SheetTab | null }): ReactNode {
  const planAwaiting = useAgentSession().items.some((item) => item.kind === "plan" && item.status === "awaiting");
  return (
    <div role="tablist" aria-label="Panels" className="mobile-tabs">
      {TABS.map((t) => {
        const selected = open === t.id;
        const needsAttention = t.id === "agent" && planAwaiting && !selected;
        return (
          <button
            key={t.id} type="button" role="tab" className="mobile-tabs__tab" data-tour={t.id === "agent" ? "agent" : undefined}
            aria-selected={selected} aria-controls={selected ? "mobile-sheet" : undefined} data-attention={needsAttention || undefined}
            onClick={() => toggleSheet(t.id)}
          >
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
            {needsAttention ? <span className="mobile-tabs__dot" role="img" aria-label="Plan waiting for approval" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Below 900 px: preview, compact timeline, and a Assets | Properties | Agent tab bar whose sheet slides up over the timeline. */
export function MobileLayout(): ReactNode {
  const sheet = uiStore.use((s) => s.sheet);
  const { canvasSize } = useSettings();
  const aspect = canvasSize.width / canvasSize.height;
  const timelineHost = useRef<HTMLDivElement>(null);
  usePinchZoom(timelineHost, ".timeline__scroll");

  useEffect(() => {
    if (sheet === null) return undefined;
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented && document.querySelector("[role='dialog'], [role='menu']") === null) closeSheet();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sheet]);

  return (
    <div className="mobile" data-sheet={sheet ?? "closed"} data-testid="mobile-layout" style={{ "--canvas-aspect": aspect } as React.CSSProperties}>
      <div className="mobile__preview"><PreviewPanel /></div>
      <div ref={timelineHost} className="mobile__timeline" inert={sheet !== null}><div className="panel-box mobile__timeline-box"><Timeline /></div></div>
      {sheet !== null ? <Sheet key={sheet} tab={sheet} /> : null}
      <TabBar open={sheet} />
    </div>
  );
}
