import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./Button";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** What failed, e.g. "the editor"; shown in the heading. */
  scope: string;
  /** Label of the recovery button. Recovery remounts the subtree. */
  reloadLabel?: string;
  /** Secondary escape hatch, e.g. back to the projects list. */
  onExit?: { label: string; run: () => void };
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  attempt: number;
}

/** Catches render errors so a bug in one panel never leaves a blank page; the project is autosaved, so reloading is safe. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, componentStack: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private reload = (): void => {
    this.setState((s) => ({ error: null, componentStack: null, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    const { error, componentStack, attempt } = this.state;
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>;
    const { scope, reloadLabel = "Reload project", onExit } = this.props;
    return (
      <div className="loading-screen error-screen" role="alert">
        <strong>Something went wrong in {scope}</strong>
        <p className="muted">Your work is saved automatically. Reloading usually fixes this.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <Button onClick={this.reload}>{reloadLabel}</Button>
          {onExit ? <Button variant="outline" onClick={onExit.run}>{onExit.label}</Button> : null}
        </div>
        <details className="error-screen__details">
          <summary>Error details</summary>
          <pre>{[error.name + ": " + error.message, error.stack, componentStack].filter(Boolean).join("\n\n")}</pre>
        </details>
      </div>
    );
  }
}
