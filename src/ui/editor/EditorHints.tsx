import { useEffect, useRef, type ReactNode } from "react";
import { useEditorState } from "#/app/hooks";
import { projectHasNoElements } from "#/engine/model";
import { getHintStore } from "../lib/hints";
import { getTourStore, isAutomated } from "../lib/tour";
import { toast } from "../primitives/toast";
import { Tour } from "../tour/Tour";

/** First-run guidance for an open project: the guided tour once, and a one-time tip when the first clip lands. */
export function EditorHints(): ReactNode {
  const empty = useEditorState((state) => projectHasNoElements((state.preview ?? state.doc).scenes));
  const wasEmpty = useRef(empty);

  useEffect(() => {
    getTourStore().autoStart(isAutomated(navigator, location.search));
  }, []);

  useEffect(() => {
    const hints = getHintStore();
    if (wasEmpty.current && !empty && !hints.isSeen("first-clip")) {
      hints.markSeen("first-clip");
      toast.info("Nice. Your first clip is on the timeline", "Press Space to play, S to split at the playhead, and drag a clip's edges to trim.", { durationMs: 9000 });
    }
    wasEmpty.current = empty;
  }, [empty]);

  return <Tour />;
}
