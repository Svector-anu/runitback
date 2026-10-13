# runitback-mcp

MCP server for [RunItBack](https://github.com/Svector-anu/runitback), the in-browser video editor. It lets Claude Code (or any MCP client) edit the project open in your browser tab, using your Claude subscription through Claude Code.

## Quick start

1. Run once in your terminal:

   ```sh
   claude mcp add runitback -- npx -y runitback-mcp@0.1.0
   ```

   If you use the hosted editor rather than a local copy, add its origin so the server accepts that page:
   `claude mcp add runitback -- npx -y runitback-mcp@0.1.0 --allow-origin https://<your-editor-host>`

2. In Claude Code say: "show the RunItBack pairing code".
3. In RunItBack, open the Agent panel, expand "Use your Claude subscription (Claude Code)" and type the 6-digit code.

## How it works

`stdio MCP <-> this process <-> ws://127.0.0.1:7777 <-> editor tab`. The WebSocket listens on loopback only (7777, or the next free port up to 7781). The editor finds it by itself while the card is open. The pairing code is single use, expires after 2 minutes and allows 3 wrong tries; the browser origin must be loopback or explicitly allowlisted. See `docs/SECURITY.md` in the repository for the threat model.

## Options

| Flag | Env | Meaning |
| --- | --- | --- |
| `--port` | `RUNITBACK_MCP_PORT` | Fixed port (default: 7777, else next free up to 7781; `0` = any) |
| `--allow-origin` | `RUNITBACK_MCP_ALLOWED_ORIGINS` | Comma separated extra browser origins, exact match, none by default |
| `--editor-url` | `RUNITBACK_EDITOR_URL` | Editor URL used in the advanced fallback link |

## Tools

`show_pairing_code`, `editor_status`, plus every editor tool (project, moments, edits, `render_frame`, `export_project`...), re-exposed with their schemas once a tab is paired.

MIT licensed.
