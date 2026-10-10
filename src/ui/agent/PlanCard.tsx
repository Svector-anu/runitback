import { useState, type ReactNode } from "react";
import type { PlanItemStatus, PlanStepView } from "#/app/agent/session";
import type { Plan, PlanStepStatus } from "#/engine/agent";
import { Button } from "../primitives/Button";

interface PlanCardProps {
  plan: Plan;
  revision: number;
  status: PlanItemStatus;
  steps: PlanStepView[];
  verification: string;
  feedback: string;
  onApprove(): void;
  onRevise(feedback: string): void;
  onReject(): void;
}

const STEP_LABEL: Record<PlanStepStatus, string> = { pending: "Pending", running: "Running", done: "Done", failed: "Failed" };

const STATUS_LABEL: Record<PlanItemStatus, string> = {
  awaiting: "Waiting for your approval",
  approved: "Approved",
  revising: "Waiting for a revised plan",
  rejected: "Rejected. Nothing was changed.",
  superseded: "Replaced by a newer plan",
  cancelled: "Stopped before it was approved. Nothing was changed.",
};

export function PlanCard(props: PlanCardProps): ReactNode {
  const { plan, status } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const awaiting = status === "awaiting";
  const sendRevision = (): void => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    setDraft("");
    props.onRevise(text);
  };

  return (
    <section className={`agent-plan agent-plan--${status}`} aria-label={`Plan, revision ${props.revision}`} data-testid="agent-plan" data-status={status}>
      <header className="agent-plan__head">
        <strong>Plan</strong>
        <span className="agent-plan__status" data-testid="agent-plan-status">{STATUS_LABEL[status]}</span>
      </header>
      <p className="agent-plan__summary">{plan.summary}</p>
      <ol className="agent-plan__steps">
        {plan.steps.map((step, i) => {
          const view = props.steps[i];
          const stepStatus = view?.status ?? "pending";
          return (
            <li key={i} className={`agent-plan__step agent-plan__step--${stepStatus}`} data-testid="agent-plan-step" data-status={stepStatus}>
              <div className="agent-plan__intent">
                <span className="agent-plan__badge">{STEP_LABEL[stepStatus]}</span> {step.intent}
              </div>
              <div className="agent-plan__meta">Tools: {step.tools.join(", ") || "none"}</div>
              {step.targets.length > 0 ? <div className="agent-plan__meta">Targets: {step.targets.join("; ")}</div> : null}
              <div className="agent-plan__meta">Check: {step.check}</div>
              {view?.note ? <div className="agent-plan__note" data-testid="agent-plan-note">{view.note}</div> : null}
              {view?.results.map((r, j) => (
                <div key={j} className={r.ok ? "agent-plan__result" : "agent-plan__result agent-plan__result--error"}>{r.summary}</div>
              ))}
            </li>
          );
        })}
      </ol>
      {props.feedback && status === "revising" ? <p className="agent-plan__meta">Your changes: {props.feedback}</p> : null}
      {props.verification ? <p className="agent-plan__verification" data-testid="agent-plan-verification">Verification: {props.verification}</p> : null}
      {awaiting ? (
        <div className="agent-plan__actions">
          {editing ? (
            <>
              <label className="agent-sr-only" htmlFor="agent-plan-feedback">What should change in the plan?</label>
              <textarea
                id="agent-plan-feedback" className="textarea" rows={3} value={draft} placeholder="What should change in the plan?"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="agent-actions">
                <Button size="sm" disabled={draft.trim() === ""} onClick={sendRevision}>Send changes</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </>
          ) : (
            <div className="agent-actions">
              <Button size="sm" onClick={props.onApprove}>Approve</Button>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
              <Button size="sm" variant="destructive-outline" onClick={props.onReject}>Reject</Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
