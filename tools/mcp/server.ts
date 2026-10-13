import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BRIDGE_PORT } from "../../src/platform/agent-bridge-protocol";
import { BridgeServer } from "./bridge-server";
import { createMcpServer } from "./mcp-server";

interface Config {
  port: number;
  /** True when the user chose no port: take 7777 or the next free one in the small range. */
  scanPorts: boolean;
  editorUrl: string;
  allowedOrigins: string[];
}

function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const requested = flag("port") ?? env.RUNITBACK_MCP_PORT ?? env.OPENCUT_MCP_PORT;
  const port = Number(requested ?? DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port '${String(requested)}'`);
  const allowed = (flag("allow-origin") ?? (env.RUNITBACK_MCP_ALLOWED_ORIGINS ?? env.OPENCUT_MCP_ALLOWED_ORIGINS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { port, scanPorts: requested === undefined, editorUrl: flag("editor-url") ?? (env.RUNITBACK_EDITOR_URL ?? env.OPENCUT_EDITOR_URL) ?? "http://localhost:5173", allowedOrigins: allowed };
}

const stderr = (line: string): void => {
  process.stderr.write(`[runitback-mcp] ${line}\n`);
};

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2), process.env);
  const bridge = new BridgeServer({ port: config.port, scanPorts: config.scanPorts, allowedOrigins: config.allowedOrigins, log: stderr });
  const port = await bridge.listen();
  const connectUrl = `${config.editorUrl.replace(/\/$/, "")}/#/projects?agent=${port}&token=${bridge.token}`;
  stderr(`listening on ws://127.0.0.1:${port} (loopback only)`);
  const pairing = bridge.issuePairingCode();
  stderr(`pairing code ${pairing.code} (2 minutes, works once). Open RunItBack, expand "Use your Claude subscription" in the Agent panel and type it. Ask Claude Code for show_pairing_code if it expires.`);
  stderr(`advanced fallback, open this link and click "Allow": ${connectUrl}`);

  const server = createMcpServer({ bridge, connectUrl: () => connectUrl });
  await server.connect(new StdioServerTransport());

  const shutdown = (): void => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((error: unknown) => {
  stderr(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
