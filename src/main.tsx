import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui/styles/tokens.css";
import "./ui/styles/base.css";
import "./ui/styles/components.css";
import "./ui/styles/editor.css";
import "./ui/styles/agent.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);
void import("./app/agent-bridge-wiring").then((m) => m.initAgentBridge());
