import { useEffect, useRef } from "react";
import { useEditorState } from "#/app/hooks";
import { closeSheet, openSheet } from "#/app/ui-state";
import { projectHasNoElements } from "#/engine/model";
import { TOUR_STEPS, useTour } from "../lib/tour";
import { useViewport } from "./use-viewport";

/**
 * Compact layout only. Opens the Assets sheet for a brand-new project so Import is the first thing in reach, and moves the
 * sheet to wherever the guided tour is pointing so the highlighted control is on screen.
 */
export function useMobileSheetAutopilot(enabled: boolean): void {
  const { compact } = useViewport();
  const empty = useEditorState((state) => projectHasNoElements((state.preview ?? state.doc).scenes));
  const tour = useTour();
  const greeted = useRef(false);

  useEffect(() => {
    if (!enabled || !compact || greeted.current) return;
    greeted.current = true;
    if (empty) openSheet("assets");
  }, [enabled, compact, empty]);

  const target = tour.open ? TOUR_STEPS[tour.step]?.target : undefined;
  useEffect(() => {
    if (!enabled || !compact || target === undefined) return;
    if (target === "import" || target === "understand") openSheet("assets");
    else closeSheet();
  }, [enabled, compact, target]);
}
