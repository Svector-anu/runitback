import { useState, type ReactNode } from "react";
import { getServices } from "#/app/services";
import { useTracks } from "#/app/hooks";
import type { SceneTracks } from "#/engine/model";
import { ONBOARDING_DISMISSED_PREF, isBoolean } from "#/platform/prefs";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";

function isEmptyProject(tracks: SceneTracks): boolean {
  return tracks.main.elements.length === 0
    && tracks.overlay.every((track) => track.elements.length === 0)
    && tracks.audio.every((track) => track.elements.length === 0);
}

export function OnboardingHint(): ReactNode {
  const { prefs } = getServices();
  const tracks = useTracks();
  const [dismissed, setDismissed] = useState(() => prefs.read(ONBOARDING_DISMISSED_PREF, false, isBoolean));

  if (dismissed || !isEmptyProject(tracks)) return null;

  return (
    <div className="banner" role="status" data-testid="onboarding-hint">
      Import your first clip, Transcribe it for captions, Index visuals to search by what's on screen, or ask the Agent to help build your edit.
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
