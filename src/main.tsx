import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { browserBackend } from "./platform/prefs";
import { migrateLegacyStorage } from "./platform/legacy-migration";
import "./ui/styles/tokens.css";
import "./ui/styles/base.css";
import "./ui/styles/components.css";
import "./ui/styles/editor.css";
import "./ui/styles/agent.css";
import "./ui/styles/mobile.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

async function bootstrap(container: HTMLElement): Promise<void> {
  try {
    await migrateLegacyStorage({ factory: indexedDB, prefs: browserBackend() });
  } catch (error) {
    console.warn("Could not migrate data from the previous storage names", error);
  }
  const { App } = await import("./App");
  createRoot(container).render(<StrictMode><App /></StrictMode>);
  void import("./app/agent-bridge-wiring").then((m) => m.initAgentBridge());
}

void bootstrap(root);
