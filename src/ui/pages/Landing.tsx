import type { ReactNode } from "react";
import { navigate } from "#/app/router";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon, Logo } from "../icons";
import { Button } from "../primitives/Button";

const FEATURES = [
  { title: "Sees your footage", body: "The agent watches your clips, reads references, and knows what's on screen before it edits." },
  { title: "Edits through real tools", body: "Every change runs through the same typed commands and undo stack a human uses — one agent turn, one undo step." },
  { title: "Verifies its own work", body: "It renders and measures the result before calling a cut done, instead of guessing." },
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
        <p>An agent-native video editor. It sees your footage, understands references, edits through the same tools you do, and verifies its own work. All in your browser.</p>
        <Button size="lg" style={{ height: 44, fontSize: "var(--text-base)" }} onClick={() => location.assign("/app")}>Start editing<Icon name="arrow-right" /></Button>
      </main>
      <section className="landing__features" aria-label="Features">
        {FEATURES.map((f) => <div key={f.title} className="landing__feature"><h3>{f.title}</h3><p>{f.body}</p></div>)}
      </section>
    </div>
  );
}
