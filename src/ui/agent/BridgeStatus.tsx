import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Button } from "../primitives/Button";

export type BridgePhase = "pending" | "connecting" | "connected" | "waiting" | "rejected" | "stopped" | "invalid";

export interface BridgeView {
  phase: BridgePhase;
  endpoint: string;
  detail: string | null;
  /** Size in bytes of an export the agent produced and the user may download. */
  exportBytes: number | null;
}

/** What the chip needs from the wiring layer; keeps this component free of sockets and services. */
export interface BridgeController {
  subscribe(listener: () => void): () => void;
  getView(): BridgeView;
  allow(): void;
  dismiss(): void;
  disconnect(): void;
  downloadExport(): void;
}

const CHIP: CSSProperties = {
  position: "fixed", right: 12, bottom: 12, zIndex: 60, display: "flex", alignItems: "center", gap: 8, maxWidth: 440,
  padding: "6px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--card)",
  color: "var(--card-foreground)", fontSize: "var(--text-xs)", boxShadow: "0 4px 16px rgb(0 0 0 / 0.25)",
};

function dotColor(phase: BridgePhase): string {
  if (phase === "connected") return "var(--constructive)";
  if (phase === "rejected" || phase === "invalid") return "var(--destructive)";
  return "var(--caution)";
}

function label(view: BridgeView): string {
  switch (view.phase) {
    case "pending": return `An AI agent wants to control this editor via ${view.endpoint}.`;
    case "connecting": return "Agent: connecting...";
    case "connected": return "Agent: connected";
    case "waiting": return `Agent: disconnected, retrying${view.detail ? ` (${view.detail})` : ""}`;
    case "rejected": return `Agent: rejected${view.detail ? ` (${view.detail})` : ""}`;
    case "stopped": return "Agent: disconnected";
    case "invalid": return view.detail ?? "Agent link is invalid";
  }
}

const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function BridgeStatus({ controller }: { controller: BridgeController }): ReactNode {
  const view = useSyncExternalStore(controller.subscribe, controller.getView);
  const active = view.phase === "connecting" || view.phase === "connected" || view.phase === "waiting";
  return (
    <div style={CHIP} role="status" aria-live="polite" data-testid="agent-bridge-status" data-phase={view.phase}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor(view.phase), flex: "none" }} />
      <span>{label(view)}</span>
      {view.phase === "pending" && (
        <>
          <Button size="sm" onClick={controller.allow}>Allow</Button>
          <Button size="sm" variant="ghost" onClick={controller.dismiss}>Dismiss</Button>
        </>
      )}
      {view.exportBytes !== null && (
        <Button size="sm" variant="outline" onClick={controller.downloadExport}>Download export ({mb(view.exportBytes)})</Button>
      )}
      {active && <Button size="sm" variant="ghost" onClick={controller.disconnect}>Disconnect</Button>}
    </div>
  );
}
