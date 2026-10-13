import type { ReactNode } from "react";
import { EXTERNAL_LINK_PROPS } from "../landing/parts";
import { INSPIRATION } from "./templates-content";

/** Collapsed, text-only list of posts that inspired the templates. Links only: no thumbnails, no embeds, nothing hotlinked. */
export function Inspiration(): ReactNode {
  return (
    <details className="tg-inspo zn-frame" data-testid="inspiration">
      <summary className="tg-inspo__summary"><span className="zn-h3">{INSPIRATION.title}</span></summary>
      <div className="tg-inspo__body">
        <p className="tg-inspo__note">{INSPIRATION.note}</p>
        <ul className="tg-inspo__list">
          {INSPIRATION.entries.map((entry) => (
            <li key={entry.href}>
              <a href={entry.href} {...EXTERNAL_LINK_PROPS}>{entry.handle}</a>
              <span>{entry.note}</span>
            </li>
          ))}
        </ul>
        <p className="tg-inspo__credit">
          Collected by {INSPIRATION.collection.curator} at <a href={INSPIRATION.collection.href} {...EXTERNAL_LINK_PROPS}>{INSPIRATION.collection.label}</a>. The videos belong to their creators; we link to them and do not embed or copy them.
        </p>
      </div>
    </details>
  );
}
