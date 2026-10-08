import type { ReactNode } from "react";
import { navigate } from "#/app/router";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon, Logo } from "../icons";
import { Button } from "../primitives/Button";

const FEATURES = [
  { title: "Private by design", body: "Your media never leaves your browser. Projects and files are stored locally." },
  { title: "A real timeline", body: "Multiple tracks, trimming, splitting, snapping, ripple editing, keyframes and undo." },
  { title: "Export in the browser", body: "Render MP4 or WebM with your edits and audio, using the video encoder built into your browser." },
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
        <h1>The open source <em>video editor</em></h1>
        <p>A simple but powerful video editor that gets the job done. It runs entirely in your browser.</p>
        <Button size="lg" style={{ height: 44, fontSize: "var(--text-base)" }} onClick={() => navigate("/projects")}>Start editing<Icon name="arrow-right" /></Button>
      </main>
      <section className="landing__features" aria-label="Features">
        {FEATURES.map((f) => <div key={f.title} className="landing__feature"><h3>{f.title}</h3><p>{f.body}</p></div>)}
      </section>
    </div>
  );
}
