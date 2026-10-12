import type { ReactNode } from "react";
import type { UnreadableProject } from "#/engine/persistence";
import { Button } from "../primitives/Button";

const REASON_TITLE: Record<UnreadableProject["reason"], string> = {
  "newer-version": "Cannot open: saved by a newer version",
  damaged: "Cannot open: damaged",
};

const REASON_HELP: Record<UnreadableProject["reason"], string> = {
  "newer-version": "Update the app to open it. Nothing was changed; export the raw data to keep a copy.",
  damaged: "The saved data could not be read. Nothing was deleted; export the raw data to keep a copy.",
};

export function UnreadableProjectCard({ project, onExportRaw, onDelete, onRetry }: {
  project: UnreadableProject; onExportRaw: () => void; onDelete: () => void; onRetry: () => void;
}): ReactNode {
  const label = project.name ?? project.id;
  return (
    <div className="project-card project-card--unreadable" role="group" aria-label={`Unreadable project ${label}`} data-reason={project.reason}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8, border: "1px solid var(--destructive, currentColor)", borderRadius: 8 }}>
      <strong className="truncate">{label}</strong>
      <span role="status">{REASON_TITLE[project.reason]}</span>
      <span className="muted">{REASON_HELP[project.reason]}</span>
      <code className="muted truncate" title={project.detail}>{project.detail}</code>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button variant="outline" onClick={onRetry}>Retry</Button>
        <Button variant="outline" onClick={onExportRaw}>Export raw</Button>
        <Button variant="destructive-outline" onClick={onDelete}>Delete</Button>
      </div>
    </div>
  );
}
