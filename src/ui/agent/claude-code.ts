import type { BridgePhase } from "./BridgeStatus";

export const RUNITBACK_REPO_URL = "https://github.com/Svector-anu/runitback";

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

export const MCP_PACKAGE = "runitback-mcp";
export const MCP_PACKAGE_VERSION = "0.1.0";
/** Flip to true in the release that follows `npm publish` of packages/mcp (see docs/RELEASE.md). */
export const RUNITBACK_MCP_PUBLISHED: boolean = false;

/**
 * The one command the user runs. A page on a non-loopback origin (the hosted site) is refused by the bridge unless that
 * origin is allowlisted, so the command adds the flag; local development needs none. Until the npm package exists the
 * command clones the repo and registers it by absolute path (`$PWD` is expanded by the user's shell).
 */
export function buildSetupCommand(input: { origin: string; published?: boolean }): string {
  const published = input.published ?? RUNITBACK_MCP_PUBLISHED;
  const allow = isLoopbackOrigin(input.origin) || input.origin === "" ? "" : ` --allow-origin ${input.origin}`;
  if (published) return `claude mcp add runitback -- npx -y ${MCP_PACKAGE}@${MCP_PACKAGE_VERSION}${allow}`;
  return `git clone ${RUNITBACK_REPO_URL}.git runitback && cd runitback && pnpm install && claude mcp add runitback -- pnpm --dir "$PWD" exec tsx tools/mcp/server.ts${allow}`;
}

export interface BridgeChipState {
  tone: "idle" | "waiting" | "ok" | "error";
  label: string;
}

export interface PairingChipInput {
  phase: "idle" | "searching" | "not_found" | "found" | "pairing" | "paired";
}

/** Chip for the card: a live bridge session wins; otherwise it reflects the pairing search. */
export function describeClaudeCode(input: { bridge: { phase: BridgePhase; detail: string | null } | null; pairing: PairingChipInput }): BridgeChipState {
  const searching = input.pairing.phase !== "idle" && input.pairing.phase !== "not_found";
  if (input.bridge && !(input.bridge.phase === "stopped" && searching)) return describeBridge(input.bridge);
  switch (input.pairing.phase) {
    case "searching": return { tone: "waiting", label: "Claude Code: looking on this computer..." };
    case "not_found": return { tone: "idle", label: "Claude Code: not found yet" };
    case "found": return { tone: "waiting", label: "Claude Code found: enter the 6-digit code" };
    case "pairing": return { tone: "waiting", label: "Claude Code: pairing..." };
    case "paired": return { tone: "waiting", label: "Claude Code: connecting..." };
    case "idle": return describeBridge(null);
  }
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
