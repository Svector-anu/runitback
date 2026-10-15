# Driving the editor from an MCP client

An external agent (Claude Code, Claude Desktop, any MCP client) can edit the project open in your browser tab. A small Node process speaks MCP over stdio on one side and a loopback WebSocket to the editor tab on the other.

```
MCP client --stdio--> tools/mcp/server.ts --ws://127.0.0.1:7777--> editor tab (src/platform/agent-bridge.ts)
```

## Quick start (3 steps)

1. Run once in a terminal. The Agent panel card copies the exact command for the site you are on.
   - Published package (`RUNITBACK_MCP_PUBLISHED` is true in `src/ui/agent/claude-code.ts`): `claude mcp add runitback -- npx -y runitback-mcp@0.1.0`
   - Until it is published: `git clone https://github.com/Svector-anu/runitback.git runitback && cd runitback && pnpm install && claude mcp add runitback -- pnpm --dir "$PWD" exec tsx tools/mcp/server.ts`
   - On the hosted site the command ends with `--allow-origin https://<host>`.
2. In Claude Code say "show the RunItBack pairing code" (tool `show_pairing_code`; the server also prints a code when it starts).
3. In RunItBack open Agent, expand "Use your Claude subscription (Claude Code)" and type the 6-digit code.

The card looks for the server on `ws://127.0.0.1:7777` (next free port up to 7781) by itself, only while the card is open, and shows "Claude Code found: enter the 6-digit code" when it answers. The code is single use, valid for 2 minutes, allows 3 wrong tries and is accepted only from loopback or allowlisted browser origins. Typing the right code gives the page the session token over that connection and connects; Disconnect is always in the chip at the bottom right. Threat model: `docs/SECURITY.md` ("Local agent bridge pairing").

The package lives in `packages/mcp` (built from `tools/mcp` with `pnpm build:mcp`, a Vite SSR build; `ws` and the MCP SDK are declared dependencies). Publishing is an owner step: `docs/RELEASE.md`.

## Advanced: connect with a link

Without the code box, call `editor_status` in Claude Code. While no editor is attached it returns the pairing code and a fallback link such as

```
http://localhost:5173/#/projects?agent=7777&token=<random>
```

(the server also prints it to stderr). Open it, open or create a project, and click **Allow** in the chip at the bottom right. In the card this is "Advanced: paste a link instead". Nothing connects until you click Allow. If the server restarts, ask for the new link (the token changes every run). Already inside a project? Append `?agent=<port>&token=<token>` to the hash route: `#/editor/<id>?agent=7777&token=...`, then reload. The token is removed from the address bar as soon as it is read.

Options (flags or env): `--port` / `RUNITBACK_MCP_PORT` (default: 7777, or the next free port up to 7781 when none is given; an explicit port is never moved; `0` = any free port), `--editor-url` / `RUNITBACK_EDITOR_URL` (default `http://localhost:5173`, only used in the printed link), `--allow-origin` / `RUNITBACK_MCP_ALLOWED_ORIGINS` (legacy `OPENCUT_MCP_ALLOWED_ORIGINS` still read; comma separated extra browser origins, exact match, none by default, e.g. a self-hosted or the hosted editor).

The editor page must call `initAgentBridge()` from `src/app/agent-bridge-wiring.ts` once at startup (it is a no-op without the `agent` URL parameter).

## Using a Claude subscription

Anthropic does not allow third-party apps to use Pro or Max subscription logins, so RunItBack never asks for, stores or forwards one. A subscriber's compliant routes are:

1. **Claude Code** (Anthropic's own client) drives the editor through this MCP server. The subscription is used by Claude Code only; the editor page and the server never see it.
2. A normal **Anthropic API key** for the in-app agent (billed by Anthropic per use, kept in the browser; see `docs/SECURITY.md`).

The Agent panel has a collapsible card, "Use your Claude subscription (Claude Code)": a title, one sentence, three numbered steps, one Copy button for one command, a status chip, and collapsed "What can Claude Code do?", "Why not sign in with Claude?" and "Advanced: paste a link instead". It is open when no API key is saved and collapsed once one is. The local network access hint appears only on a non-localhost site and only while the chip says it is waiting. Tokens, whether from pairing or a pasted link, are held in memory by the bridge session and never written to storage.

### FAQ answer: "Can I use my Claude subscription?"

> Yes, through Claude Code. Claude Code is Anthropic's own app: run one command, ask it for the pairing code, type the code in RunItBack and your Pro or Max plan does the editing. There is no "sign in with Claude" in the web app because Anthropic does not allow other apps to use subscription logins. For the built-in agent, use an Anthropic API key; you pay Anthropic directly, usually cents per edit.

### Hosted site vs. local copy (verified)

Checked on 2026-10 in Google Chrome 155 (Playwright `channel: "chrome"`, macOS) with a real `BridgeServer`; an `https://` page was simulated by fulfilling `https://runitback.example/` through request interception, so the origin is a genuine secure `https` origin to Chrome.

| Page origin | Result |
| --- | --- |
| `http://localhost:*` / `http://127.0.0.1:*` (`pnpm dev`, `vite preview`) | Works with no flags. Loopback origins are always accepted by the bridge, and the CSP (`connect-src ws://127.0.0.1:*`) allows the socket. Covered by `e2e/agent-bridge.spec.ts` and `e2e/conn-card.spec.ts`. |
| `https://` hosted origin, bridge started without `--allow-origin` | Refused by the bridge at the upgrade (`rejected connection from origin ...`, HTTP 403) even when Chrome lets the socket out. Default is closed. |
| `https://` hosted origin, origin allowlisted, Chrome **Local network access** permission granted | Works: handshake and `hello_ack` completed. Not blocked as mixed content: `ws://127.0.0.1` from an `https` page is permitted. |
| `https://` hosted origin, allowlisted, permission **not** granted | Blocked by Chrome before it reaches the server: `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. In headless Chrome this is an automatic deny. |

Consequences for the hosted site:

- Start the server with the hosted origin allowlisted: `--allow-origin https://<your-host>` or `RUNITBACK_MCP_ALLOWED_ORIGINS=https://<your-host>` (comma separated). Also pass `--editor-url https://<your-host>` so the link the server prints points at it. The card generates this command from `window.location.origin` when the page is not on localhost; the hosted production deployment is `https://runitback-three.vercel.app`. The allowlist is exact-match on the `Origin` header and empty by default.
- Chrome 142 and later gate requests from a public site to loopback behind a **Local network access** permission. In a normal (headed) window Chrome shows its own prompt the first time; the user must accept it. A headed run with the prompt unanswered timed out, which is consistent with a pending prompt, but the prompt itself was not captured visually, and granting it was only tested through Playwright's `grantPermissions(["local-network-access"])`.
- Only Chrome was tested. Firefox and Safari are untested and the app supports Chrome only.
- Running a local copy (`pnpm dev`) avoids the allowlist and the permission prompt, and is the lowest-friction route.

## Tools

Every tool the editor registers is exposed with its JSON schema; the list refreshes whenever the editor reconnects (clients get `tools/list_changed`). Tools run one at a time in the page. `ToolResult` images become MCP image blocks, failures become `isError` results with the hint.

| Tool | Source | What it does |
| --- | --- | --- |
| `editor_status` | MCP server | Is an editor connected, which project, how many tools. Call first when anything fails. |
| engine tools (`get_project`, edit tools, ...) | `src/engine/agent` via `createAgentTools()` | Read and edit the timeline. Times are seconds, ids are element ids. |
| `list_templates`, `describe_template`, `apply_template` | `src/engine/agent/tools-templates.ts` | Browse the 13 original templates, read a template's slots and texts, and build one in the open project in a single undo step. `apply_template` sets the canvas and is destructive, so under "Ask before editing" it needs an approved plan. See `docs/TEMPLATES.md`. |
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
