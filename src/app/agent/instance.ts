import { useSyncExternalStore } from "react";
import { getServices } from "#/app/services";
import { AgentSession, type AgentSessionState } from "./session";

let session: AgentSession | null = null;

/** The one in-app agent conversation for this page. */
export function getAgentSession(): AgentSession {
  if (!session) {
    const services = getServices();
    session = new AgentSession({
      editor: services.editor,
      runtime: () => getServices().runtime,
      prefs: services.prefs,
      currentProjectId: () => getServices().currentProjectId,
    });
  }
  return session;
}

export function useAgentSession(): AgentSessionState {
  const current = getAgentSession();
  return useSyncExternalStore(current.subscribe, current.getState);
}
