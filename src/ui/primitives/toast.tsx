import { useSyncExternalStore, type ReactNode } from "react";
import { Icon } from "../icons";

export interface ToastItem {
  id: number;
  kind: "info" | "success" | "error";
  title: string;
  description?: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export interface ToastOptions { durationMs?: number }

function push(kind: ToastItem["kind"], title: string, description?: string, options?: ToastOptions): void {
  const id = nextId++;
  items = [...items, { id, kind, title, description }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), options?.durationMs ?? (kind === "error" ? 8000 : 4000));
}

export function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  info: (title: string, description?: string, options?: ToastOptions) => push("info", title, description, options),
  success: (title: string, description?: string) => push("success", title, description),
  error: (title: string, description?: string) => push("error", title, description),
};

export function Toaster(): ReactNode {
  const current = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => items);
  return (
    <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
      {current.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          {t.kind === "success" ? <Icon name="check" /> : t.kind === "error" ? <Icon name="alert" /> : <Icon name="info" />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{t.title}</div>
            {t.description ? <div className="toast__description">{t.description}</div> : null}
          </div>
          <button type="button" className="btn btn--text" aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
