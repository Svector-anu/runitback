import { describe, expect, it } from "vitest";
import { MCP_PACKAGE_VERSION, RUNITBACK_MCP_PUBLISHED, buildSetupCommand, describeBridge, describeClaudeCode, isLoopbackOrigin } from "#/ui/agent/claude-code";

const REPO = "https://github.com/Svector-anu/runitback";

describe("buildSetupCommand", () => {
  it("published: one npx command with the version pinned and no path to fill in", () => {
    const command = buildSetupCommand({ origin: "http://localhost:5173", published: true });
    expect(command).toBe("claude mcp add runitback -- npx -y runitback-mcp@0.1.0");
    expect(command).toContain(`@${MCP_PACKAGE_VERSION}`);
    expect(command).not.toMatch(/\/Users\/|\/home\/|\/path\/to/);
  });

  it("unpublished fallback: one clone-and-register command that needs no placeholder path", () => {
    const command = buildSetupCommand({ origin: "http://localhost:5173", published: false });
    expect(command).toBe(`git clone ${REPO}.git runitback && cd runitback && pnpm install && claude mcp add runitback -- pnpm --dir "$PWD" exec tsx tools/mcp/server.ts`);
    expect(command).not.toMatch(/\/Users\/|\/home\/|\/path\/to/);
  });

  it("is unpublished until the owner flips the flag", () => {
    expect(RUNITBACK_MCP_PUBLISHED).toBe(false);
    expect(buildSetupCommand({ origin: "http://localhost:5173" })).toContain("git clone");
  });

  it("adds an explicit origin allowlist only for a non-loopback origin, in both variants", () => {
    for (const published of [true, false]) {
      expect(buildSetupCommand({ origin: "https://runitback-three.vercel.app", published })).toMatch(/ --allow-origin https:\/\/runitback-three\.vercel\.app$/);
      expect(buildSetupCommand({ origin: "http://127.0.0.1:5199", published })).not.toContain("--allow-origin");
    }
  });

  it("classifies loopback origins", () => {
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackOrigin("https://evil.localhost.example.com")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

describe("describeClaudeCode", () => {
  it("shows the pairing search when no session exists", () => {
    expect(describeClaudeCode({ bridge: null, pairing: { phase: "idle" } }).label).toBe("Claude Code: not connected");
    expect(describeClaudeCode({ bridge: null, pairing: { phase: "searching" } }).tone).toBe("waiting");
    expect(describeClaudeCode({ bridge: null, pairing: { phase: "not_found" } })).toMatchObject({ tone: "idle" });
    expect(describeClaudeCode({ bridge: null, pairing: { phase: "found" } })).toEqual({ tone: "waiting", label: "Claude Code found: enter the 6-digit code" });
  });

  it("a live session wins over pairing, except a stopped one while pairing again", () => {
    expect(describeClaudeCode({ bridge: { phase: "connected", detail: null }, pairing: { phase: "found" } }).label).toBe("Claude Code connected");
    expect(describeClaudeCode({ bridge: { phase: "rejected", detail: "x" }, pairing: { phase: "found" } }).tone).toBe("error");
    expect(describeClaudeCode({ bridge: { phase: "stopped", detail: null }, pairing: { phase: "found" } }).label).toContain("enter the 6-digit code");
    expect(describeClaudeCode({ bridge: { phase: "stopped", detail: null }, pairing: { phase: "not_found" } }).label).toBe("Claude Code: disconnected");
  });
});

describe("describeBridge", () => {
  it("is idle with no session and reports each phase honestly", () => {
    expect(describeBridge(null)).toEqual({ tone: "idle", label: "Claude Code: not connected" });
    expect(describeBridge({ phase: "pending", detail: null }).tone).toBe("waiting");
    expect(describeBridge({ phase: "connected", detail: null })).toEqual({ tone: "ok", label: "Claude Code connected" });
    expect(describeBridge({ phase: "waiting", detail: "socket closed" }).label).toContain("socket closed");
    expect(describeBridge({ phase: "rejected", detail: "bad token" }).tone).toBe("error");
    expect(describeBridge({ phase: "stopped", detail: null }).tone).toBe("idle");
  });
});
