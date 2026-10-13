import { useState, type ReactNode } from "react";
import { getServices } from "#/app/services";
import { reportCapabilities } from "#/platform/capabilities";
import { isString } from "#/platform/prefs";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";

const BROWSER_NOTICE_DISMISSED_PREF = "browser-notice-dismissed";

/** One-time notice for browsers that lack something the editor uses. Dismissal is remembered per set of missing features. */
export function BrowserNotice(): ReactNode {
  const { prefs } = getServices();
  const [report] = useState(() => reportCapabilities());
  const signature = report.issues.map((issue) => issue.id).join(",");
  const [dismissed, setDismissed] = useState(() => prefs.read(BROWSER_NOTICE_DISMISSED_PREF, "", isString) === signature);
  const first = report.issues[0];
  if (!first || dismissed) return null;
  const more = report.issues.length - 1;
  return (
    <div className="banner" role="status" data-testid="browser-notice" data-level={report.level}>
      <span>{first.message}{more > 0 ? ` (${more} more limitation${more === 1 ? "" : "s"}, see Browser support in the README)` : ""}</span>
      <Button variant="text" label="Dismiss notice" onClick={() => { prefs.write(BROWSER_NOTICE_DISMISSED_PREF, signature); setDismissed(true); }}>
        <Icon name="x" size={14} />
      </Button>
    </div>
  );
}
