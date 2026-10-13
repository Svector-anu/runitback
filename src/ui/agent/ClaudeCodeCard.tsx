import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { connectBridgeFromLink, getBridgeController, subscribeBridgeController } from "#/app/agent-bridge-wiring";
import { pairing } from "#/app/agent-pairing";
import { PAIRING_CODE_LENGTH } from "#/platform/agent-bridge-protocol";
import { Button } from "../primitives/Button";
import type { BridgeController, BridgeView } from "./BridgeStatus";
import { CLAUDE_CODE_TOOLS, buildSetupCommand, describeClaudeCode, isLoopbackOrigin } from "./claude-code";

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

/** Short onboarding for driving RunItBack from Claude Code over MCP: the compliant way to use a Claude subscription. */
export function ClaudeCodeCard({ open, onOpenChange, origin = window.location.origin }: { open: boolean; onOpenChange: (open: boolean) => void; origin?: string }): ReactNode {
  const controller = useSyncExternalStore(subscribeBridgeController, getBridgeController);
  const view = useBridgeView(controller);
  const pairingView = useSyncExternalStore(pairing.subscribe, pairing.getView);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const [code, setCode] = useState("");
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const command = buildSetupCommand({ origin });
  const hosted = !isLoopbackOrigin(origin);
  const status = describeClaudeCode({ bridge: view, pairing: pairingView });
  const needsPairing = view === null || view.phase === "stopped";
  const codeBoxVisible = pairingView.phase === "found" || pairingView.phase === "pairing";

  useEffect(() => {
    if (!open || !needsPairing) return undefined;
    pairing.start();
    return pairing.stop;
  }, [open, needsPairing]);

  const copy = async (): Promise<void> => {
    const ok = await writeClipboard(command);
    setCopied(ok ? "done" : "failed");
    setTimeout(() => setCopied(null), COPY_RESET_MS);
  };
  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    void pairing.submit(code).then(() => setCode(""));
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
        <p className="cc-card__lead">Let Claude Code edit this project with your Claude subscription. Everything stays on your computer.</p>
        <ol className="cc-steps">
          <li>
            <strong>Run this once in your terminal.</strong>
            <code className="cc-code" data-testid="claude-code-command">{command}</code>
            <Button size="sm" variant="outline" onClick={() => void copy()} aria-describedby="cc-copy-state">Copy command</Button>
            <span id="cc-copy-state" className="cc-copied" role="status" aria-live="polite">
              {copied === "done" ? "Copied" : copied === "failed" ? "Copy failed. Select the command and copy it." : ""}
            </span>
          </li>
          <li><strong>In Claude Code, say &ldquo;show the RunItBack pairing code&rdquo;.</strong></li>
          <li>
            <strong>Type the {PAIRING_CODE_LENGTH}-digit code here.</strong>
            {codeBoxVisible ? (
              <form className="cc-link" onSubmit={submitCode}>
                <label className="agent-sr-only" htmlFor="cc-code-input">6-digit pairing code</label>
                <input
                  id="cc-code-input" className="input input--sm cc-code-input" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={PAIRING_CODE_LENGTH + 1}
                  placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, PAIRING_CODE_LENGTH))}
                  aria-invalid={pairingView.error ? true : undefined} aria-describedby={pairingView.error ? "cc-code-error" : undefined}
                />
                <Button size="sm" type="submit" disabled={code.length !== PAIRING_CODE_LENGTH || pairingView.phase === "pairing"}>Pair</Button>
              </form>
            ) : null}
            {pairingView.error ? <p id="cc-code-error" className="cc-error" role="alert">{pairingView.error}</p> : null}
          </li>
        </ol>
        {hosted && status.tone === "waiting" ? <p className="cc-note">Chrome may ask to allow local network access: click Allow.</p> : null}
        <details className="cc-more">
          <summary>What can Claude Code do?</summary>
          <ul>
            {CLAUDE_CODE_TOOLS.map((tool) => <li key={tool.name}><code>{tool.name}</code> {tool.does}</li>)}
          </ul>
        </details>
        <details className="cc-more">
          <summary>Why not sign in with Claude?</summary>
          <p>Anthropic does not let other apps use a Claude subscription login, but its own Claude Code can.</p>
        </details>
        <details className="cc-more">
          <summary>Advanced: paste a link instead</summary>
          <p>Ask Claude Code to call <code>editor_status</code>, paste the link it returns, then click Allow. The token is not stored.</p>
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
        </details>
      </div>
    </details>
  );
}
