import { describe, expect, it } from "vitest";
import { buildMcpAddCommand, describeBridge, isLoopbackOrigin } from "#/ui/agent/claude-code";

describe("buildMcpAddCommand", () => {
  it("uses a placeholder path, never a real home directory", () => {
    const command = buildMcpAddCommand("http://localhost:5173");
    expect(command).toBe("claude mcp add runitback -- pnpm --dir /path/to/runitback exec tsx tools/mcp/server.ts");
    expect(command).not.toMatch(/\/Users\/|\/home\//);
  });

  it("adds an explicit origin allowlist only for a non-loopback origin", () => {
    expect(buildMcpAddCommand("https://runitback-three.vercel.app")).toMatch(/--editor-url https:\/\/runitback-three\.vercel\.app --allow-origin https:\/\/runitback-three\.vercel\.app$/);
    expect(buildMcpAddCommand("http://127.0.0.1:5199")).not.toContain("--allow-origin");
  });

  it("classifies loopback origins", () => {
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackOrigin("https://evil.localhost.example.com")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
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
