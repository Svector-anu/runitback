import type { BridgePhase } from "./BridgeStatus";

export const RUNITBACK_REPO_URL = "https://github.com/Svector-anu/runitback";
export const MCP_PATH_PLACEHOLDER = "/path/to/runitback";

export const CLAUDE_CODE_TOOLS: ReadonlyArray<{ name: string; does: string }> = [
  { name: "get_project", does: "read your timeline, tracks and clips" },
  { name: "find_moments", does: "search footage by what is said or shown" },
  { name: "insert_media / split / trim", does: "edit the timeline with the same tools you have" },
  { name: "render_frame", does: "look at any frame to check its own work" },
  { name: "export_project", does: "render an MP4 or WebM (you click Download)" },
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The `claude mcp add` command for this deployment. A page on a non-loopback origin (the hosted site) is refused by
 * the bridge unless that origin is allowlisted, so the command adds both flags; local development needs neither.
 */
export function buildMcpAddCommand(origin: string): string {
  const base = `claude mcp add runitback -- pnpm --dir ${MCP_PATH_PLACEHOLDER} exec tsx tools/mcp/server.ts`;
  return isLoopbackOrigin(origin) || origin === "" ? base : `${base} --editor-url ${origin} --allow-origin ${origin}`;
}

export interface BridgeChipState {
  tone: "idle" | "waiting" | "ok" | "error";
  label: string;
}

export function describeBridge(view: { phase: BridgePhase; detail: string | null } | null): BridgeChipState {
  if (!view) return { tone: "idle", label: "Claude Code: not connected" };
  const detail = view.detail ? ` (${view.detail})` : "";
  switch (view.phase) {
    case "pending": return { tone: "waiting", label: "Claude Code: waiting for you to click Allow" };
    case "connecting": return { tone: "waiting", label: "Claude Code: connecting..." };
    case "connected": return { tone: "ok", label: "Claude Code connected" };
    case "waiting": return { tone: "waiting", label: `Claude Code: waiting, retrying${detail}` };
    case "rejected": return { tone: "error", label: `Claude Code: rejected${detail}` };
    case "invalid": return { tone: "error", label: view.detail ?? "Claude Code: link is invalid" };
    case "stopped": return { tone: "idle", label: "Claude Code: disconnected" };
  }
}
