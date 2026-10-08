import type { ReactNode } from "react";
import { uiStore, type AssetTab } from "#/app/ui-state";
import { Icon, type IconName } from "../icons";
import { Button } from "../primitives/Button";
import { Tooltip } from "../primitives/Tooltip";
import { MediaView } from "./MediaView";
import { CaptionsView, EffectsView, GraphicsView, TextView } from "./OtherViews";
import { SettingsView } from "./SettingsView";

const TABS: Array<{ id: AssetTab; label: string; icon: IconName }> = [
  { id: "media", label: "Media", icon: "folder" },
  { id: "text", label: "Text", icon: "type" },
  { id: "graphics", label: "Graphics", icon: "shapes" },
  { id: "effects", label: "Effects", icon: "wand" },
  { id: "captions", label: "Captions", icon: "captions" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

export function AssetsPanel(): ReactNode {
  const active = uiStore.use((s) => s.assetTab);
  const view = active === "media" ? <MediaView /> : active === "text" ? <TextView /> : active === "graphics" ? <GraphicsView />
    : active === "effects" ? <EffectsView /> : active === "captions" ? <CaptionsView /> : <SettingsView />;
  return (
    <div className="panel panel-box assets" style={{ width: "100%" }}>
      <div className="assets__rail scrollbar-hidden" role="tablist" aria-label="Asset tabs" aria-orientation="vertical">
        {TABS.map((tab) => (
          <Tooltip key={tab.id} content={tab.label} side="right" delay={100}>
            <Button role="tab" aria-selected={tab.id === active} variant={tab.id === active ? "secondary" : "ghost"} size="icon-lg" label={tab.label}
              className={tab.id === active ? "" : "btn--muted"} onClick={() => uiStore.set({ assetTab: tab.id })}>
              <Icon name={tab.icon} />
            </Button>
          </Tooltip>
        ))}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex" }} role="tabpanel" aria-label={TABS.find((t) => t.id === active)?.label}>{view}</div>
    </div>
  );
}
