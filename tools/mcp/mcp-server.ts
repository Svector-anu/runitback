import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { RpcClosedError, RpcTimeoutError, type ToolDescriptor } from "../../src/platform/agent-bridge-protocol";
import { BridgeServer, NoEditorError } from "./bridge-server";
import { errorResult, toMcpResult, type McpToolResult } from "./result";

export const STATUS_TOOL = "editor_status";
export const PAIRING_TOOL = "show_pairing_code";

export interface PairingNotice {
  code: string;
  secondsLeft: number;
  failedAttempts: number;
}

export function pairingInstructions(notice: PairingNotice): string {
  const warning = notice.failedAttempts > 0 ? ` Warning: ${notice.failedAttempts} wrong code attempt(s) were made against this server; if the user did not make them, something else on this computer is guessing.` : "";
  return `Tell the user to open RunItBack, open "Use your Claude subscription (Claude Code)" in the Agent panel and type this 6-digit code: ${notice.code} (valid for ${notice.secondsLeft} seconds, works once). Call show_pairing_code for a fresh code.${warning}`;
}

export function connectInstructions(input: { connectUrl: string; pairing: PairingNotice }): string {
  return `No RunItBack editor is connected. ${pairingInstructions(input.pairing)} Fallback if the code box is not available: the user opens this link and clicks "Allow" in the agent chip at the bottom right: ${input.connectUrl}`;
}

function pairingTool(): Tool {
  return {
    name: PAIRING_TOOL,
    description: "Show the 6-digit code that pairs the RunItBack editor tab with this server. Call it when the user asks to connect or open RunItBack.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  };
}

function statusTool(): Tool {
  return {
    name: STATUS_TOOL,
    description: "Report whether a browser editor is connected to this MCP server, and which project it has open. Call this first if other tools fail.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  };
}

function toMcpTool(tool: ToolDescriptor): Tool {
  const schema = tool.inputSchema as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...schema, type: "object", properties: (schema.properties as Record<string, object> | undefined) ?? {} },
    annotations: { readOnlyHint: tool.readOnly },
  };
}

/** MCP front end: every browser tool is re-exposed with its schema; the tool list refreshes whenever the editor reconnects. */
export function createMcpServer(input: { bridge: BridgeServer; connectUrl: () => string }): Server {
  const { bridge } = input;
  const notice = (): PairingNotice => {
    const issued = bridge.issuePairingCode();
    return { code: issued.code, secondsLeft: Math.max(1, Math.round((issued.expiresAt - Date.now()) / 1000)), failedAttempts: bridge.pairing.failedAttempts };
  };
  const instructions = (): string => connectInstructions({ connectUrl: input.connectUrl(), pairing: notice() });
  const server = new Server({ name: "runitback", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [statusTool(), pairingTool(), ...bridge.toolList.map(toMcpTool)] }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<McpToolResult> => {
    const { name } = request.params;
    if (name === STATUS_TOOL) {
      const editor = bridge.editor;
      const text = editor
        ? JSON.stringify({ connected: true, projectId: editor.projectId, editorVersion: editor.editorVersion, tools: bridge.toolList.length })
        : JSON.stringify({ connected: false, instructions: instructions() });
      return { content: [{ type: "text", text }] };
    }
    if (name === PAIRING_TOOL) {
      return { content: [{ type: "text", text: bridge.editor ? "An editor is already connected. Pairing is only needed after it disconnects." : pairingInstructions(notice()) }] };
    }
    if (!bridge.editor) return errorResult(instructions());
    if (!bridge.toolList.some((t) => t.name === name)) {
      return errorResult(`Unknown tool '${name}'. Available: ${bridge.toolList.map((t) => t.name).join(", ") || "(none)"}`);
    }
    try {
      return toMcpResult(await bridge.callTool(name, request.params.arguments ?? {}));
    } catch (error) {
      if (error instanceof NoEditorError) return errorResult(instructions());
      if (error instanceof RpcTimeoutError) return errorResult(`The editor did not answer '${name}' within ${error.timeoutMs / 1000}s. It may be busy (for example exporting) or the tab may be in the background; try again.`);
      if (error instanceof RpcClosedError) return errorResult(`The editor disconnected during '${name}'. Reopen the tab and call editor_status; the edit may or may not have been applied.`);
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  });

  const notify = (): void => {
    void server.sendToolListChanged().catch(() => undefined);
  };
  bridge.on("tools", notify);
  return server;
}
