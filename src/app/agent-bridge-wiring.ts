import { createElement } from "react";
import { createRoot } from "react-dom/client";
import * as agentModule from "#/engine/agent";
import type { AgentTool, AgentToolRegistry, ToolContext, ToolResult } from "#/engine/agent";
import { exportProject } from "#/export/exporter";
import { DEFAULT_EXPORT_OPTIONS, exportFileName, type ExportOptions } from "#/export/plan";
import { AgentBridgeClient, type BridgeSocket, type BridgeStatus as ClientStatus } from "#/platform/agent-bridge";
import { renderFrameJpeg, DEFAULT_FRAME_MAX_SIZE, MAX_FRAME_MAX_SIZE } from "#/platform/agent-bridge-frame";
import { DEFAULT_BRIDGE_PORT } from "#/platform/agent-bridge-protocol";
import { BridgeStatus, type BridgeController, type BridgePhase, type BridgeView } from "#/ui/agent/BridgeStatus";
import { getServices } from "./services";

const EDITOR_VERSION = "0.1.0";
const QUALITIES: ReadonlyArray<ExportOptions["quality"]> = ["low", "medium", "high", "very_high"];
const FORMATS: ReadonlyArray<ExportOptions["format"]> = ["mp4", "webm"];

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

function numberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function renderFrameTool(): AgentTool {
  return {
    name: "render_frame",
    description: "Render the composed timeline at a time and return it as a JPEG image, exactly as preview and export would draw it. Use it to look at the result of an edit.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "number", minimum: 0, description: "Timeline time in seconds (clamped to the last frame)." },
        maxSize: { type: "integer", minimum: 16, maximum: MAX_FRAME_MAX_SIZE, description: `Longest image side in pixels (default ${DEFAULT_FRAME_MAX_SIZE}).` },
      },
      required: ["time"],
      additionalProperties: false,
    },
    readOnly: true,
    async run(input): Promise<ToolResult> {
      const args = (input ?? {}) as { time?: unknown; maxSize?: unknown };
      if (typeof args.time !== "number" || !Number.isFinite(args.time) || args.time < 0) {
        return { ok: false, error: "'time' must be a non-negative number of seconds", hint: 'Example: {"time": 2.5}' };
      }
      const maxSize = args.maxSize === undefined ? undefined : numberInRange(args.maxSize, 16, MAX_FRAME_MAX_SIZE);
      if (args.maxSize !== undefined && maxSize === null) return { ok: false, error: `'maxSize' must be a number between 16 and ${MAX_FRAME_MAX_SIZE}` };
      const { editor, runtime } = getServices();
      if (!editor.hasProject) return { ok: false, error: "No project is open in the editor", hint: "Open a project in the browser tab first." };
      const frame = await renderFrameJpeg({ doc: editor.effectiveDoc(), runtime, seconds: args.time, maxSize: maxSize ?? undefined });
      const caption = `frame at ${frame.seconds.toFixed(2)}s (${frame.width}x${frame.height})`;
      return {
        ok: true,
        summary: `Rendered ${caption}`,
        data: { seconds: frame.seconds, width: frame.width, height: frame.height },
        images: [{ mediaType: "image/jpeg", base64: frame.base64, caption }],
      };
    },
  };
}

interface PendingExport {
  blob: Blob;
  fileName: string;
}

function exportTool(onExport: (result: PendingExport) => void): AgentTool {
  let running = false;
  return {
    name: "export_project",
    description: "Export the whole timeline to a video file in the browser and report its size, duration and codecs. The bytes are not returned: the user downloads the file from the 'Download export' button next to the agent status chip.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: FORMATS, description: "Container: mp4 (H.264/AAC) or webm (VP9/Opus). Default mp4." },
        quality: { type: "string", enum: QUALITIES, description: "Default high." },
        includeAudio: { type: "boolean", description: "Default true." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async run(input): Promise<ToolResult> {
      const args = (input ?? {}) as { format?: unknown; quality?: unknown; includeAudio?: unknown };
      const format = args.format ?? DEFAULT_EXPORT_OPTIONS.format;
      const quality = args.quality ?? DEFAULT_EXPORT_OPTIONS.quality;
      const includeAudio = args.includeAudio ?? DEFAULT_EXPORT_OPTIONS.includeAudio;
      if (!FORMATS.includes(format as ExportOptions["format"])) return { ok: false, error: `'format' must be one of ${FORMATS.join(", ")}` };
      if (!QUALITIES.includes(quality as ExportOptions["quality"])) return { ok: false, error: `'quality' must be one of ${QUALITIES.join(", ")}` };
      if (typeof includeAudio !== "boolean") return { ok: false, error: "'includeAudio' must be a boolean" };
      if (running) return { ok: false, error: "An export is already running", hint: "Wait for it to finish and call export_project again." };
      const services = getServices();
      if (!services.editor.hasProject) return { ok: false, error: "No project is open in the editor" };
      running = true;
      try {
        services.editor.playback.pause();
        const result = await exportProject({
          doc: services.editor.getState().doc, getBlob: services.runtime.getBlob,
          options: { format: format as ExportOptions["format"], quality: quality as ExportOptions["quality"], includeAudio },
        });
        const fileName = exportFileName(services.editor.getState().meta?.name ?? "export", result.extension);
        onExport({ blob: result.blob, fileName });
        return {
          ok: true,
          summary: `Exported ${result.width}x${result.height}, ${result.durationSeconds.toFixed(2)}s, ${(result.blob.size / 1_000_000).toFixed(1)} MB. The user can download it from the editor.`,
          data: {
            fileName, mimeType: result.mimeType, bytes: result.blob.size, width: result.width, height: result.height,
            durationSeconds: result.durationSeconds, frameCount: result.frameCount, hasAudio: result.hasAudio,
            videoCodec: result.videoCodec, audioCodec: result.audioCodec,
          },
        };
      } finally {
        running = false;
      }
    },
  };
}

function engineTools(): AgentToolRegistry {
  const create = (agentModule as Record<string, unknown>).createAgentTools;
  if (typeof create !== "function") return new Map();
  const made: unknown = create();
  if (made instanceof Map) return made as AgentToolRegistry;
  if (Array.isArray(made)) return new Map((made as AgentTool[]).map((t) => [t.name, t]));
  return new Map();
}

export function createBridgeRegistry(onExport: (result: PendingExport) => void): Map<string, AgentTool> {
  const registry = new Map<string, AgentTool>(engineTools());
  for (const tool of [renderFrameTool(), exportTool(onExport)]) registry.set(tool.name, tool);
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
