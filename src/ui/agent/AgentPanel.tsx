import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { getAgentSession, useAgentSession } from "#/app/agent/instance";
import type { ChatItem } from "#/app/agent/session";
import { AGENT_MODELS } from "#/app/agent/model-client";
import { useEditorState } from "#/app/hooks";
import { Button } from "../primitives/Button";
import { Tooltip } from "../primitives/Tooltip";
import { Icon } from "../icons";
import { ANTHROPIC_KEYS_URL } from "../lib/links";
import { PlanCard, PlanHint } from "./PlanCard";

const EXAMPLE_PROMPTS = [
  "Build a rough cut: put my clips on the timeline in a sensible order and trim obvious dead air.",
  "Remove every silence longer than half a second from the footage on the timeline.",
  "Add a title card at the start that says \"Summer 2025\" for three seconds.",
  "Check my edit: look at frames across the timeline and tell me what to fix.",
];

const KEY_IDLE_MS = 900;
const ASK_BEFORE_EDITING_HELP = "The agent shows a plan first and changes your timeline only after you approve it. Turn this off to let it edit straight away.";
const WARNING = "Your API key is kept in this browser only and is sent only to Anthropic. Anyone using this browser profile can read it.";
const MODEL_NOTE = "Sonnet balances quality and speed. Opus is the strongest and costs the most. Haiku is the fastest and cheapest.";

function ToolChip({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): ReactNode {
  const state = item.status === "running" ? "running..." : item.status === "ok" ? "done" : "failed";
  return (
    <details className={`agent-chip agent-chip--${item.status}`} data-testid="agent-tool-chip" data-tool={item.name} data-status={item.status}>
      <summary>
        <span className="agent-chip__name">{item.name}</span>
        <span className="agent-chip__state">{state}</span>
        {item.summary ? <span className="agent-chip__summary">{item.summary}</span> : null}
      </summary>
      <div className="agent-chip__body">
        <div className="agent-chip__label">Arguments</div>
        <pre>{JSON.stringify(item.args, null, 2)}</pre>
        {item.detail ? (
          <>
            <div className="agent-chip__label">Result</div>
            <pre>{item.detail}</pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

type PlanItem = Extract<ChatItem, { kind: "plan" }>;

function PlanItemCard({ item, docked }: { item: PlanItem; docked: boolean }): ReactNode {
  const session = getAgentSession();
  return (
    <PlanCard
      plan={item.plan} revision={item.revision} status={item.status} steps={item.steps} verification={item.verification} feedback={item.feedback} docked={docked}
      onApprove={() => session.approvePlan()} onRevise={(text) => session.revisePlan(text)} onReject={() => session.rejectPlan()}
    />
  );
}

function Item({ item }: { item: ChatItem }): ReactNode {
  switch (item.kind) {
    case "user":
      return <div className="agent-msg agent-msg--user">{item.text}</div>;
    case "assistant":
      return <div className="agent-msg agent-msg--assistant" data-testid="agent-assistant-text">{item.text}</div>;
    case "tool":
      return <ToolChip item={item} />;
    case "image":
      return (
        <figure className="agent-frame">
          <img src={`data:${item.mediaType};base64,${item.base64}`} alt={item.caption || "Rendered frame"} data-testid="agent-frame" />
          {item.caption ? <figcaption>{item.caption}</figcaption> : null}
        </figure>
      );
    case "plan":
      return <PlanItemCard item={item} docked={false} />;
    case "notice":
      return <div className={`agent-notice agent-notice--${item.tone}`} role={item.tone === "error" ? "alert" : undefined}>{item.text}</div>;
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function AgentPanel(): ReactNode {
  const session = getAgentSession();
  const state = useAgentSession();
  const projectId = useEditorState((s) => s.meta?.id ?? null);
  const currentDoc = useEditorState((s) => s.doc);
  const [draft, setDraft] = useState("");
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const hasKey = state.apiKey !== "";
  const [settledKey, setSettledKey] = useState(state.apiKey);
  const showSettingsFields = settledKey === "" || settingsExpanded;
  const showOptions = settingsExpanded;
  const modelLabel = AGENT_MODELS.find((m) => m.id === state.model)?.label ?? state.model;

  useEffect(() => {
    session.bindProject(projectId);
  }, [session, projectId]);

  useEffect(() => {
    const timer = setTimeout(() => setSettledKey(state.apiKey), KEY_IDLE_MS);
    return () => clearTimeout(timer);
  }, [state.apiKey]);

  useEffect(() => {
    const log = logRef.current;
    if (log && state.items.length > 0) log.scrollTop = log.scrollHeight;
  }, [state.items.length, state.streaming]);

  const canUndo = !state.running && state.undoableDoc !== null && state.undoableDoc === currentDoc;
  const submit = (): void => {
    const text = draft.trim();
    if (!text || state.running) return;
    setDraft("");
    void session.send(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const awaitingPlan = state.items.find((item): item is PlanItem => item.kind === "plan" && item.status === "awaiting");
  const logItems = awaitingPlan ? state.items.filter((item) => item !== awaitingPlan) : state.items;
  const announcement = awaitingPlan
    ? `Plan ready for your approval: ${awaitingPlan.plan.summary} Approve, Edit or Reject.`
    : state.running ? `Agent is working, step ${state.step}` : "";

  return (
    <section className={`agent-panel panel-box${awaitingPlan ? " agent-panel--planning" : ""}`} aria-label="Agent" data-testid="agent-panel">
      <div className="agent-header" data-testid={showSettingsFields ? undefined : "agent-settings-summary"}>
        <span className="agent-header__model">{modelLabel}</span>
        <span className="agent-header__mode" title={ASK_BEFORE_EDITING_HELP}>{state.askBeforeEditing ? "Plan first" : "Edits directly"}</span>
        <Button size="icon" variant="ghost" label="Undo agent changes" disabled={!canUndo} onClick={() => session.undoLast()}><Icon name="undo" size={15} /></Button>
        <Button size="icon" variant="ghost" label="New chat" disabled={state.running || state.items.length === 0} onClick={() => session.reset()}><Icon name="plus" size={15} /></Button>
        {settingsExpanded ? (
          <Button
            size="sm" variant="secondary" className="agent-header__gear" aria-expanded="true" aria-controls="agent-settings-fields"
            onClick={() => setSettingsExpanded(false)}
          >
            <Icon name="sliders" size={14} /> Done
          </Button>
        ) : (
          <Button
            size="icon" variant="ghost" className="agent-header__gear" label="Agent settings" aria-expanded="false" aria-controls="agent-settings-fields"
            onClick={() => setSettingsExpanded(true)}
          >
            <Icon name="sliders" size={15} />
          </Button>
        )}
      </div>

      {showSettingsFields ? (
        <div id="agent-settings-fields" className="agent-settings-fields">
          {showOptions ? <div className="agent-field">
            <label className="label" htmlFor="agent-model">Model</label>
            <select id="agent-model" className="select" value={state.model} title={MODEL_NOTE} disabled={state.running} onChange={(e) => session.setModel(e.target.value)}>
              {AGENT_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div> : null}
          <div className="agent-field">
            <label className="label" htmlFor="agent-api-key">Anthropic API key</label>
            <input
              id="agent-api-key" className="input input--sm" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-..."
              value={state.apiKey} onChange={(e) => session.setApiKey(e.target.value)} aria-describedby="agent-key-warning"
            />
            {state.apiKey === "" ? (
              <p className="agent-warning agent-warning--required" role="status" data-testid="agent-key-hint">
                An Anthropic API key is required. <a href={ANTHROPIC_KEYS_URL} target="_blank" rel="noopener noreferrer">Where do I get a key?</a>
              </p>
            ) : null}
          </div>
          <details className="agent-privacy">
            <summary>Privacy and cost</summary>
            <p id="agent-key-warning" className="agent-warning">{WARNING}</p>
            <p className="agent-warning" data-testid="agent-key-help">
              {hasKey ? <><a href={ANTHROPIC_KEYS_URL} target="_blank" rel="noopener noreferrer">Where do I get a key?</a>{" "}</> : null}
              You pay Anthropic directly for what the agent uses. RunItBack adds no charge.
            </p>
            <p className="agent-warning">{MODEL_NOTE}</p>
          </details>
          {showOptions ? <Tooltip content={ASK_BEFORE_EDITING_HELP} side="bottom" delay={250}>
            <label className="agent-toggle">
              <input
                type="checkbox" checked={state.askBeforeEditing} disabled={state.running} aria-describedby="agent-ask-help"
                onChange={(e) => session.setAskBeforeEditing(e.target.checked)}
              />
              Ask before editing
              <span id="agent-ask-help" className="agent-sr-only">{ASK_BEFORE_EDITING_HELP}</span>
            </label>
          </Tooltip> : null}
        </div>
      ) : null}

      <div ref={logRef} className="agent-log" role="log" aria-label="Agent conversation" aria-relevant="additions text">
        {state.items.length === 0 ? (
          <div className="agent-empty" data-testid="agent-empty">
            <p>
              Describe an edit. {state.askBeforeEditing ? "The agent shows a plan first and edits only after you approve it, then" : "The agent edits your timeline, then"} checks its own work.
              One undo reverts everything it did.
            </p>
            <ul className="agent-examples" aria-label="Example prompts">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <li key={prompt}><button type="button" className="agent-example" onClick={() => setDraft(prompt)}>{prompt}</button></li>
              ))}
            </ul>
          </div>
        ) : logItems.map((item) => <Item key={item.id} item={item} />)}
        {awaitingPlan ? <PlanHint /> : null}
        {state.running && !awaitingPlan ? (
          <div className="agent-msg agent-msg--assistant agent-msg--streaming" data-testid="agent-streaming">
            {state.streaming || `Working... (step ${state.step})`}
          </div>
        ) : null}
      </div>
      <div className="agent-sr-only" role="status" aria-live="polite">{announcement}</div>

      {awaitingPlan ? <div className="agent-dock"><PlanItemCard key={awaitingPlan.id} item={awaitingPlan} docked /></div> : null}

      {(state.running && !awaitingPlan) || state.exportFile ? (
        <div className="agent-actions">
          {state.running && !awaitingPlan ? <Button size="sm" variant="destructive-outline" onClick={() => session.stop()}>Stop</Button> : null}
          {state.exportFile ? (
            <Button size="sm" variant="outline" onClick={() => state.exportFile && downloadBlob(state.exportFile.blob, state.exportFile.fileName)}>Download export</Button>
          ) : null}
        </div>
      ) : null}
      <div className="agent-compose">
        <label className="agent-sr-only" htmlFor="agent-input">Message to the agent</label>
        <textarea
          id="agent-input" className="textarea" rows={2} value={draft} disabled={state.running}
          placeholder={awaitingPlan ? "Decide on the plan above" : hasKey ? "What should I edit?" : "Add your API key above, then describe the edit"}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
        />
        <Button size="sm" disabled={state.running || draft.trim() === ""} onClick={submit}>Send</Button>
      </div>
    </section>
  );
}
