# Driving the editor from an MCP client

An external agent (Claude Code, Claude Desktop, any MCP client) can edit the project open in your browser tab. A small Node process speaks MCP over stdio on one side and a loopback WebSocket to the editor tab on the other.

```
MCP client --stdio--> tools/mcp/server.ts --ws://127.0.0.1:<port>--> editor tab (src/platform/agent-bridge.ts)
```

## Connect from Claude Code

```sh
claude mcp add opencut -- pnpm --dir /path/to/repo exec tsx tools/mcp/server.ts
```

Start the editor (`pnpm dev`), then in Claude Code call `editor_status`. While no editor is attached it returns a link such as

```
http://localhost:5173/#/projects?agent=7777&token=<random>
```

(the server also prints it to stderr). Open it, open or create a project, and click **Allow** in the chip at the bottom right. Nothing connects until you click Allow. The chip shows the connection state and has **Disconnect**. Closing the tab disconnects cleanly; if the server restarts, ask for the new link (the token changes every run).

Already inside a project? Append `?agent=<port>&token=<token>` to the hash route: `#/editor/<id>?agent=7777&token=...`, then reload. The token is removed from the address bar as soon as it is read.

Options (flags or env): `--port` / `OPENCUT_MCP_PORT` (default 7777, `0` = any free port), `--editor-url` / `OPENCUT_EDITOR_URL` (default `http://localhost:5173`, only used in the printed link), `--allow-origin` / `OPENCUT_MCP_ALLOWED_ORIGINS` (comma separated extra browser origins, e.g. a self-hosted editor).

The editor page must call `initAgentBridge()` from `src/app/agent-bridge-wiring.ts` once at startup (it is a no-op without the `agent` URL parameter).

## Tools

Every tool the editor registers is exposed with its JSON schema; the list refreshes whenever the editor reconnects (clients get `tools/list_changed`). Tools run one at a time in the page. `ToolResult` images become MCP image blocks, failures become `isError` results with the hint.

| Tool | Source | What it does |
| --- | --- | --- |
| `editor_status` | MCP server | Is an editor connected, which project, how many tools. Call first when anything fails. |
| engine tools (`get_project`, edit tools, ...) | `src/engine/agent` via `createAgentTools()` | Read and edit the timeline. Times are seconds, ids are element ids. |
| `render_frame` `{time, maxSize?}` | bridge | Composes the timeline at `time` seconds with the same plan and compositor as preview and export; returns a JPEG whose long side is at most `maxSize` (default 1024, max 2048). |
| `export_project` `{format?, quality?, includeAudio?}` | bridge | Runs the real export in the page and returns size, duration, frame count and codecs. Bytes are **not** sent to the agent: the file is held in the page and a **Download export** button appears in the chip. The download starts only when you click it. |

## Wire protocol (version 1)

JSON text frames, `type` discriminated, max 32 MiB each.

- browser -> server: `hello {protocol, token, editorVersion, projectId}` first; later `tools {id, tools[]}`, `result {id, result}`, `pong {id}`.
- server -> browser: `hello_ack {protocol, sessionId}` or `reject {reason}` (then close code 4401); `list_tools {id}`, `call_tool {id, name, input}`, `ping {id}`.
- The browser reconnects with exponential backoff (0.5 s to 10 s, jittered) unless it was rejected or the user disconnected. A new editor connection replaces the old one (close code 4409).
- Calls time out after 120 s on the server; the model gets an error telling it to retry.

## Threat model

Anything that can reach this socket and pass the handshake can edit your project and render its frames, so the server is deliberately narrow.

- Listens on `127.0.0.1` only. The `Host` header must be loopback (blocks DNS rebinding).
- Browsers always send `Origin`; connections from non-loopback origins are refused at the upgrade, so a random website cannot open the socket. Extra origins need an explicit flag.
- A random 192-bit per-session token must be in the first message (constant-time compare); wrong token, wrong protocol, a non-hello first frame or a silent socket (5 s) are closed.
- The browser never opens the socket until the user clicks Allow on the in-page banner, and the user can disconnect at any time.
- Frames over 32 MiB are dropped (the socket is closed with 1009).
- No `eval`, no shell and no file-system access in any tool: tools can only run registered editor commands, render frames and export. Exports never touch disk without a user click.

Out of scope: a malicious process already running as you on the same machine can read the printed token from the MCP client's stderr. The MCP client itself is trusted with the whole project; the token only authenticates the browser to the server.
