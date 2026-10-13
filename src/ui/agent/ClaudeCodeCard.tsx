import { useState, useSyncExternalStore, type ReactNode } from "react";
import { connectBridgeFromLink, getBridgeController, subscribeBridgeController } from "#/app/agent-bridge-wiring";
import { Button } from "../primitives/Button";
import type { BridgeController, BridgeView } from "./BridgeStatus";
import {
  CLAUDE_CODE_TOOLS, MCP_PATH_PLACEHOLDER, RUNITBACK_REPO_URL, buildMcpAddCommand, describeBridge, isLoopbackOrigin,
} from "./claude-code";

const COPY_RESET_MS = 2000;
const noopSubscribe = (): (() => void) => () => undefined;
const noView = (): BridgeView | null => null;

function useBridgeView(controller: BridgeController | null): BridgeView | null {
  return useSyncExternalStore(controller ? controller.subscribe : noopSubscribe, controller ? controller.getView : noView);
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Collapsible onboarding for driving RunItBack from Claude Code over MCP: the compliant way to use a Claude subscription. */
export function ClaudeCodeCard({ open, onOpenChange, origin = window.location.origin }: { open: boolean; onOpenChange: (open: boolean) => void; origin?: string }): ReactNode {
  const controller = useSyncExternalStore(subscribeBridgeController, getBridgeController);
  const view = useBridgeView(controller);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const command = buildMcpAddCommand(origin);
  const hosted = !isLoopbackOrigin(origin);
  const status = describeBridge(view);

  const copy = async (): Promise<void> => {
    const ok = await writeClipboard(command);
    setCopied(ok ? "done" : "failed");
    setTimeout(() => setCopied(null), COPY_RESET_MS);
  };
  const connect = (): void => {
    const result = connectBridgeFromLink(link);
    setLinkError(result.ok ? null : result.error);
    if (result.ok) setLink("");
  };

  return (
    <details className="cc-card" open={open} onToggle={(e) => onOpenChange(e.currentTarget.open)} data-testid="claude-code-card">
      <summary className="cc-card__summary">
        <span className="cc-card__title">Use your Claude subscription (Claude Code)</span>
        <span className={`cc-status cc-status--${status.tone}`} role="status" data-testid="claude-code-status" data-tone={status.tone}>
          <span className="cc-status__dot" aria-hidden />
          {status.label}
        </span>
        {view?.phase === "pending" ? <Button size="sm" onClick={() => controller?.allow()}>Allow Claude Code to edit</Button> : null}
      </summary>
      <div className="cc-card__body">
        <p className="cc-card__lead">
          Anthropic does not let other apps sign in with a Claude subscription, so RunItBack cannot do that. Claude Code can: it is Anthropic's own app,
          and it can drive this editor through RunItBack's MCP server. Nothing about your subscription reaches this page.
        </p>
        <ol className="cc-steps">
          <li>
            <strong>Get the code and install it once.</strong>
            <code className="cc-code">git clone {RUNITBACK_REPO_URL}.git && cd runitback && pnpm install</code>
          </li>
          <li>
            <strong>Add the server to Claude Code.</strong> Replace <code>{MCP_PATH_PLACEHOLDER}</code> with the folder from step 1.
            <code className="cc-code" data-testid="claude-code-command">{command}</code>
            <Button size="sm" variant="outline" onClick={() => void copy()} aria-describedby="cc-copy-state">Copy command</Button>
            <span id="cc-copy-state" className="cc-copied" role="status" aria-live="polite">
              {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed. Select the command and copy it." : ""}
            </span>
          </li>
          <li>
            <strong>Ask Claude Code for the editor link.</strong> In Claude Code say &ldquo;open RunItBack&rdquo; (it calls <code>editor_status</code>). The link carries a
            one-time token that changes every run. Paste it here, then click Allow. The token is not stored.
            <div className="cc-link">
              <label className="agent-sr-only" htmlFor="cc-link-input">Link from Claude Code</label>
              <input
                id="cc-link-input" className="input input--sm" type="password" autoComplete="off" spellCheck={false} placeholder="Paste the link from Claude Code"
                value={link} onChange={(e) => { setLink(e.target.value); setLinkError(null); }} aria-invalid={linkError ? true : undefined}
                aria-describedby={linkError ? "cc-link-error" : undefined}
              />
              <Button size="sm" disabled={link.trim() === ""} onClick={connect}>Connect</Button>
            </div>
            {linkError ? <p id="cc-link-error" className="cc-error" role="alert">{linkError}</p> : null}
          </li>
        </ol>
        <p className="cc-note">
          {hosted
            ? <>This site is not on localhost, so the command above allowlists <code>{origin}</code> on your own machine, and Chrome will ask once to allow this site to connect to devices on your network (local network access). Only Chrome has been tested.</>
            : <>You are on a local copy, so the bridge accepts this page without extra flags. The bridge listens on 127.0.0.1 only.</>}
          {" "}Nothing connects until you click Allow, and Disconnect is always in the chip at the bottom right.
        </p>
        <div className="cc-tools">
          <span className="cc-tools__title">Claude Code can</span>
          <ul>
            {CLAUDE_CODE_TOOLS.map((tool) => <li key={tool.name}><code>{tool.name}</code> {tool.does}</li>)}
          </ul>
        </div>
      </div>
    </details>
  );
}
