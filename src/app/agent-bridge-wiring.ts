import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createAgentTools, type AgentTool, type ToolContext } from "#/engine/agent";
import { AgentBridgeClient, type BridgeSocket, type BridgeStatus as ClientStatus } from "#/platform/agent-bridge";
import { DEFAULT_BRIDGE_PORT } from "#/platform/agent-bridge-protocol";
import { BridgeStatus, type BridgeController, type BridgePhase, type BridgeView } from "#/ui/agent/BridgeStatus";
import { createPlatformTools, sharedAnalysisStore, type PendingExport } from "./agent/platform-tools";
import { createAnalysisProvider, getStyleProfileStore } from "./agent/reference-wiring";
import { createAppTemporalTools } from "./agent/temporal-wiring";
import { createAppTranscriptTools } from "./agent/transcript-wiring";
import { createAppVisualTools } from "./agent/visual-wiring";
import { getServices } from "./services";

const EDITOR_VERSION = "0.1.0";

export interface BridgeRequest {
  port: number;
  token: string | null;
}

/** Reads `agent=<port>` and `token=<secret>` from the query string or from the query inside the hash route. */
export function parseBridgeRequest(loc: { search: string; hash: string }): BridgeRequest | null {
  const hashQuery = loc.hash.includes("?") ? loc.hash.slice(loc.hash.indexOf("?")) : "";
  for (const query of [hashQuery, loc.search]) {
    const params = new URLSearchParams(query);
    const raw = params.get("agent");
    if (raw === null) continue;
    const port = raw === "" || raw === "1" || raw === "true" ? DEFAULT_BRIDGE_PORT : Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { port: NaN, token: null };
    return { port, token: params.get("token") };
  }
  return null;
}

export function createBridgeRegistry(onExport: (result: PendingExport) => void): Map<string, AgentTool> {
  const services = getServices();
  const provider = createAnalysisProvider({ editor: services.editor, runtime: () => getServices().runtime, analysisStore: sharedAnalysisStore });
  const registry = new Map<string, AgentTool>(createAgentTools({ reference: { store: getStyleProfileStore(), provider } }));
  const platform = createPlatformTools({
    editor: services.editor, runtime: () => getServices().runtime, analysisStore: sharedAnalysisStore, onExport,
  });
  for (const tool of platform) registry.set(tool.name, tool);
  for (const tool of createAppTranscriptTools()) registry.set(tool.name, tool);
  for (const tool of createAppTemporalTools(provider)) registry.set(tool.name, tool);
  for (const tool of createAppVisualTools()) registry.set(tool.name, tool);
  return registry;
}

const PHASE_OF: Record<ClientStatus["state"], BridgePhase> = {
  idle: "connecting", connecting: "connecting", connected: "connected", waiting: "waiting", rejected: "rejected", stopped: "stopped",
};

class BridgeSession implements BridgeController {
  private view: BridgeView;
  private readonly listeners = new Set<() => void>();
  private client: AgentBridgeClient | null = null;
  private exportResult: PendingExport | null = null;
  private readonly registry: Map<string, AgentTool>;

  constructor(private readonly request: BridgeRequest) {
    const endpoint = `ws://127.0.0.1:${request.port}`;
    this.registry = createBridgeRegistry((result) => {
      this.exportResult = result;
      this.update({ exportBytes: result.blob.size });
    });
    const invalid = !Number.isInteger(request.port) ? "Agent link has an invalid port" : request.token ? null : "Agent link is missing its token";
    this.view = { phase: invalid ? "invalid" : "pending", endpoint, detail: invalid, exportBytes: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): BridgeView => this.view;

  private update(patch: Partial<BridgeView>): void {
    this.view = { ...this.view, ...patch };
    for (const l of this.listeners) l();
  }

  allow = (): void => {
    if (this.view.phase !== "pending" || !this.request.token) return;
    const services = getServices();
    const context = (): ToolContext => ({ editor: services.editor, nowMs: () => Date.now() });
    const client = new AgentBridgeClient({
      url: this.view.endpoint,
      token: this.request.token,
      tools: () => this.registry,
      context,
      hello: () => ({ editorVersion: EDITOR_VERSION, projectId: services.currentProjectId }),
      createSocket: (url) => new WebSocket(url) as unknown as BridgeSocket,
    });
    client.subscribe((s) => this.update({ phase: PHASE_OF[s.state], detail: s.reason }));
    this.client = client;
    window.addEventListener("pagehide", this.disconnect, { once: true });
    this.update({ phase: "connecting", detail: null });
    client.start();
  };

  dismiss = (): void => {
    this.update({ phase: "stopped", detail: null });
  };

  disconnect = (): void => {
    this.client?.stop();
  };

  downloadExport = (): void => {
    const result = this.exportResult;
    if (!result) return;
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
}

let session: BridgeSession | null = null;

/** The token is a bearer secret: once read it is removed from the address bar, history entry and future referrers. */
function scrubToken(): void {
  const { hash, search, pathname } = window.location;
  const clean = (query: string): string => {
    const params = new URLSearchParams(query);
    params.delete("token");
    const text = params.toString();
    return text ? `?${text}` : "";
  };
  const hashPath = hash.includes("?") ? hash.slice(0, hash.indexOf("?")) : hash;
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?")) : "";
  history.replaceState(null, "", `${pathname}${clean(search)}${hashPath}${clean(hashQuery)}`);
}

/**
 * Opt-in entry point. Does nothing unless the URL carries `agent=<port>`; otherwise shows a confirmation chip
 * and opens the socket only after the user clicks Allow. Safe to call more than once.
 */
export function initAgentBridge(loc: { search: string; hash: string } = window.location): BridgeController | null {
  if (session) return session;
  const request = parseBridgeRequest(loc);
  if (!request) return null;
  if (loc === window.location) scrubToken();
  session = new BridgeSession(request);
  const host = document.createElement("div");
  host.id = "agent-bridge-root";
  document.body.appendChild(host);
  createRoot(host).render(createElement(BridgeStatus, { controller: session }));
  return session;
}
