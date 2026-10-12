import { useState, type ReactNode } from "react";
import { getServices } from "#/app/services";
import { useEditorState } from "#/app/hooks";
import { projectHasNoElements } from "#/engine/model";
import { ONBOARDING_DISMISSED_PREF, isBoolean } from "#/platform/prefs";
import { useTour } from "../lib/tour";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";

export function OnboardingHint(): ReactNode {
  const { prefs } = getServices();
  const projectIsEmpty = useEditorState((state) => projectHasNoElements((state.preview ?? state.doc).scenes));
  const tourOpen = useTour().open;
  const [dismissed, setDismissed] = useState(() => prefs.read(ONBOARDING_DISMISSED_PREF, false, isBoolean));

  if (dismissed || !projectIsEmpty || tourOpen) return null;

  return (
    <div className="banner" role="status" data-testid="onboarding-hint">
      Import a clip to start. Understand analyses it on this device, Transcribe adds captions, Index visuals lets you search by what's on screen, and the Agent edits for you.
      <Button
        variant="text"
        label="Dismiss"
        onClick={() => {
          prefs.write(ONBOARDING_DISMISSED_PREF, true);
          setDismissed(true);
        }}
      >
        <Icon name="x" size={14} />
      </Button>
    </div>
  );
}
