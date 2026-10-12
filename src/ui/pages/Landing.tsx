import type { ReactNode } from "react";
import { navigate } from "#/app/router";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon, Logo } from "../icons";
import { Button } from "../primitives/Button";

const STEPS = [
  { title: "Import", body: "Drop in videos, photos and audio. They stay in your browser." },
  { title: "Understand", body: "It finds silences, speech, scenes and faces, on your device." },
  { title: "Tell it what to do", body: "Describe the edit in plain words, like \"cut the dead air\"." },
  { title: "Review the plan", body: "The agent shows what it will change. You approve it first." },
  { title: "Export", body: "Render an MP4 or WebM and keep it. One undo reverts any agent turn." },
];

export function Landing(): ReactNode {
  const theme = uiStore.use((s) => s.theme);
  return (
    <div className="landing">
      <header className="landing__nav">
        <div className="landing__brand"><Logo size={28} />RunItBack</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Button variant="ghost" size="icon-lg" label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"} size={18} /></Button>
          <Button onClick={() => navigate("/projects")}>Projects<Icon name="arrow-right" /></Button>
        </div>
      </header>
      <main className="landing__hero">
        <h1>Tell your <em>video editor</em> what to do</h1>
        <p>RunItBack is a video editor with an AI agent built in. Import your clips, describe the edit in plain words, review the plan, and export. Your media never leaves your browser.</p>
        <Button size="lg" style={{ height: 44, fontSize: "var(--text-base)" }} onClick={() => location.assign("/app")}>Start editing<Icon name="arrow-right" /></Button>
        <ul className="landing__facts" aria-label="Requirements">
          <li>Works in Chrome</li>
          <li>Bring your own Anthropic API key</li>
          <li>No account, no upload</li>
        </ul>
      </main>
      <section className="landing__how" aria-label="How it works">
        <h2>How it works</h2>
        <ol className="landing__steps">
          {STEPS.map((step) => <li key={step.title}><strong>{step.title}</strong><span>{step.body}</span></li>)}
        </ol>
      </section>
    </div>
  );
}
