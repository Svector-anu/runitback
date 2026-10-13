import { useState, type ReactNode } from "react";
import { getServices } from "#/app/services";
import { isBoolean } from "#/platform/prefs";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { useViewport } from "./use-viewport";

const MOBILE_NOTICE_DISMISSED_PREF = "mobile-notice-dismissed";

/** One-time phone notice. It sits in the flow above the header and never blocks the editor. */
export function MobileNotice(): ReactNode {
  const { prefs } = getServices();
  const { phone } = useViewport();
  const [dismissed, setDismissed] = useState(() => prefs.read(MOBILE_NOTICE_DISMISSED_PREF, false, isBoolean));
  if (!phone || dismissed) return null;
  return (
    <div className="banner banner--mobile" role="status" data-testid="mobile-notice">
      <span>RunItBack works best on desktop Chrome; mobile is limited</span>
      <Button
        variant="text" label="Dismiss notice"
        onClick={() => { prefs.write(MOBILE_NOTICE_DISMISSED_PREF, true); setDismissed(true); }}
      >
        <Icon name="x" size={14} />
      </Button>
    </div>
  );
}
