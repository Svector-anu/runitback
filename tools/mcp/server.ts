import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BRIDGE_PORT } from "../../src/platform/agent-bridge-protocol";
import { BridgeServer } from "./bridge-server";
import { createMcpServer } from "./mcp-server";

interface Config {
  port: number;
  editorUrl: string;
  allowedOrigins: string[];
}

function parseConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number(flag("port") ?? (env.RUNITBACK_MCP_PORT ?? env.OPENCUT_MCP_PORT) ?? DEFAULT_BRIDGE_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port '${String(flag("port") ?? (env.RUNITBACK_MCP_PORT ?? env.OPENCUT_MCP_PORT))}'`);
  const allowed = (flag("allow-origin") ?? (env.RUNITBACK_MCP_ALLOWED_ORIGINS ?? env.OPENCUT_MCP_ALLOWED_ORIGINS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { port, editorUrl: flag("editor-url") ?? (env.RUNITBACK_EDITOR_URL ?? env.OPENCUT_EDITOR_URL) ?? "http://localhost:5173", allowedOrigins: allowed };
}

const stderr = (line: string): void => {
  process.stderr.write(`[runitback-mcp] ${line}\n`);
};

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2), process.env);
  const bridge = new BridgeServer({ port: config.port, allowedOrigins: config.allowedOrigins, log: stderr });
  const port = await bridge.listen();
  const connectUrl = `${config.editorUrl.replace(/\/$/, "")}/#/projects?agent=${port}&token=${bridge.token}`;
  stderr(`listening on ws://127.0.0.1:${port} (loopback only)`);
  stderr(`open this link in the browser, then click "Allow": ${connectUrl}`);
  stderr("Already inside a project? Append ?agent=" + port + "&token=<token> to that project's URL hash instead.");

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
