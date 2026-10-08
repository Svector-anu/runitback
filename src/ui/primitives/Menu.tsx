import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Popover } from "./Popover";
import { Icon, type IconName } from "../icons";

export type MenuEntry =
  | { type?: "item"; label: string; icon?: IconName; shortcut?: string; destructive?: boolean; disabled?: boolean; onSelect: () => void; checked?: boolean }
  | { type: "separator" }
  | { type: "label"; label: string };

interface MenuListProps {
  entries: ReadonlyArray<MenuEntry>;
  onClose: () => void;
}

function MenuList({ entries, onClose }: MenuListProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
      : e.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div ref={ref} onKeyDown={onKeyDown} role="presentation">
      {entries.map((entry, i) => {
        if (entry.type === "separator") return <div key={`s${i}`} role="separator" className="menu__separator" />;
        if (entry.type === "label") return <div key={`l${i}`} className="menu__label">{entry.label}</div>;
        return (
          <button
            key={`${entry.label}${i}`} type="button" role={entry.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            aria-checked={entry.checked} disabled={entry.disabled}
            className={["menu__item", entry.destructive ? "menu__item--destructive" : ""].join(" ")}
            onClick={() => { onClose(); entry.onSelect(); }}
          >
            {entry.icon ? <Icon name={entry.icon} /> : entry.checked !== undefined ? <span style={{ width: 14 }}>{entry.checked ? <Icon name="check" size={14} /> : null}</span> : null}
            <span>{entry.label}</span>
            {entry.shortcut ? <span className="menu__shortcut">{entry.shortcut}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export interface DropdownMenuProps {
  entries: ReadonlyArray<MenuEntry>;
  trigger: (props: { ref: RefObject<HTMLButtonElement | null>; onClick: () => void; "aria-haspopup": "menu"; "aria-expanded": boolean }) => ReactNode;
  align?: "start" | "end";
  width?: number;
}

export function DropdownMenu({ entries, trigger, align = "start", width }: DropdownMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    ref.current?.focus();
  }, []);
  return (
    <>
      {trigger({ ref, onClick: () => setOpen((o) => !o), "aria-haspopup": "menu", "aria-expanded": open })}
      <Popover open={open} onClose={close} anchor={ref} align={align} role="menu" className="menu">
        <div style={width ? { width } : undefined}><MenuList entries={entries} onClose={() => setOpen(false)} /></div>
      </Popover>
    </>
  );
}

export interface ContextMenuState {
  x: number;
  y: number;
}

/** Context menu opened at a pointer position; `entries` are computed by the caller when it opens. */
export function ContextMenu({ state, entries, onClose, width }: { state: ContextMenuState | null; entries: ReadonlyArray<MenuEntry>; onClose: () => void; width?: number }): ReactNode {
  const anchor = state ? { x: state.x, y: state.y } : { x: 0, y: 0 };
  return (
    <Popover open={state !== null} onClose={onClose} anchor={anchor} role="menu" className="menu">
      <div style={width ? { width } : undefined}><MenuList entries={entries} onClose={onClose} /></div>
    </Popover>
  );
}
