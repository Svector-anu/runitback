import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTemplate } from "../src/templates";
import { LANDING_CONTENT, type ShotImage } from "../src/ui/pages/landing-content";

const PUBLIC = join(__dirname, "..", "public");
const SECTION_IDS = ["product", "templates", "features", "how-it-works", "compare", "open-source", "faq"];

function allShots(): ShotImage[] {
  const c = LANDING_CONTENT;
  return [...c.hero.strip, c.product.shotLight, c.product.shotDark, c.plan.image, c.finalCta.image];
}

describe("landing content shape", () => {
  it("has non-empty copy for every required field", () => {
    const c = LANDING_CONTENT;
    for (const text of [c.brand, c.nav.cta, c.hero.status, c.hero.headline, c.hero.sub, c.hero.primaryCta, c.features.title, c.how.title, c.plan.title, c.faq.title, c.finalCta.title, c.footer.tagline]) {
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the headline and step names that the app e2e specs rely on", () => {
    expect(LANDING_CONTENT.hero.headline).toBe("Tell your video editor what to do");
    expect(LANDING_CONTENT.how.steps.map((s) => s.title)).toEqual(["Import", "Understand", "Tell it what to do", "Review the plan", "Export"]);
    expect(LANDING_CONTENT.hero.trust).toContain("Works in Chrome");
  });

  it("only links to sections that exist", () => {
    for (const link of LANDING_CONTENT.nav.links) expect(SECTION_IDS).toContain(link.target);
    for (const column of LANDING_CONTENT.footer.columns) for (const link of column.links) if (link.target) expect(SECTION_IDS).toContain(link.target);
  });

  it("has unique feature ids, a full 12-column bento and the nine agreed cards", () => {
    const items = LANDING_CONTENT.features.items;
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.map((i) => i.title)).toEqual(["Edit with words", "Find any moment", "Plan before it edits", "Private by design", "Real timeline", "Start from a template", "Effects that used to need another app", "Generate media in the editor", "Export MP4 or WebM"]);
    let row = 0;
    for (const item of items) {
      row += item.span;
      expect(row).toBeLessThanOrEqual(12);
      if (row === 12) row = 0;
    }
    expect(row).toBe(0);
  });

  it("answers every FAQ question and covers the required topics", () => {
    const faq = LANDING_CONTENT.faq.items;
    expect(faq.map((f) => f.question)).toEqual([
      "What is RunItBack?", "What can it do today?", "Is my video uploaded?", "What does it cost?", "Can it generate images, video or music?", "Can I use my Claude subscription?", "Which browsers work?",
      "What does Understand download?", "Can the agent mess up my project?", "Are templates free? Can I make my own?", "Why not just use CapCut?", "How do I contribute?",
    ]);
    for (const item of faq) {
      expect(item.question.trim().endsWith("?")).toBe(true);
      expect(item.answer.trim().length).toBeGreaterThan(20);
    }
    const questions = faq.map((f) => f.question).join(" | ");
    for (const topic of ["uploaded", "cost", "browsers", "Understand download", "RunItBack", "CapCut", "contribute", "Claude subscription", "agent mess up", "templates"]) expect(questions).toContain(topic);
  });

  it("answers the subscription question honestly: Claude Code and MCP yes, in-app subscription login no", () => {
    const answer = LANDING_CONTENT.faq.items.find((f) => /Claude subscription/.test(f.question))?.answer ?? "";
    expect(answer).toMatch(/Claude Code/);
    expect(answer).toMatch(/MCP/);
    expect(answer).toMatch(/does not allow/);
    expect(answer).toMatch(/API key/);
    expect(answer).not.toMatch(/sign in with your subscription|coming soon/i);
  });

  it("declares the MIT license and GitHub links consistently", () => {
    const c = LANDING_CONTENT;
    expect(c.license.name).toBe("MIT");
    expect(c.hero.status).toMatch(/open source/i);
    expect(c.hero.status).toMatch(/MIT/);
    for (const url of [c.github.repo, c.github.readme, c.github.contributing, c.github.license, c.github.notice, c.github.issues, c.license.url]) {
      expect(url.startsWith("https://github.com/Svector-anu/runitback")).toBe(true);
    }
    expect(c.github.starLabel).toBe("Star on GitHub");
    const answer = c.faq.items.find((f) => f.question === "What is RunItBack?")?.answer ?? "";
    expect(answer).toMatch(/MIT/);
    expect(answer).not.toMatch(/not yet|soon/i);
  });

  it("keeps the CapCut trademark note verbatim and never disparages", () => {
    expect(LANDING_CONTENT.trademarkNote).toBe("CapCut is a trademark of its respective owner. RunItBack is not affiliated with or endorsed by it.");
    const text = JSON.stringify(LANDING_CONTENT.compare).toLowerCase();
    expect(text).not.toMatch(/worse|bad|spyware|steal|scam|bloat|trash|terrible/);
  });

  it("compares honestly: CapCut is marked ahead on mobile and templates, with the check date", () => {
    const { rows, checked } = LANDING_CONTENT.compare;
    expect(rows.map((r) => r.feature)).toEqual([
      "Open source", "Runs in your browser", "Files stay on your device while editing", "Edit by describing it", "Price", "Mobile app", "Templates, stickers and effects",
    ]);
    expect(rows.find((r) => r.feature === "Mobile app")?.ahead).toBe("capcut");
    const templates = rows.find((r) => r.feature.startsWith("Templates"));
    expect(templates?.ahead).toBe("capcut");
    expect(templates?.runitback).toMatch(/8 original templates/);
    expect(templates?.runitback).toMatch(/not yet/i);
    expect(templates?.runitback).not.toMatch(/no template library|coming soon/i);
    expect(checked).toMatch(/\d{4}/);
  });

  it("never claims 100% local or no upload", () => {
    expect(JSON.stringify(LANDING_CONTENT).toLowerCase()).not.toMatch(/100% local|never uploaded|no upload/);
  });

  it("does not claim customers, ratings, metrics or star counts", () => {
    const text = JSON.stringify(LANDING_CONTENT).toLowerCase();
    expect(text).not.toMatch(/trusted by|\d+k\+? users|rated \d|testimonials|\d+k?\+?\s*stars|apache|gpl/);
  });

  it("does not mark shipped work (filters, transitions, templates) as coming soon", () => {
    const shipped = JSON.stringify([LANDING_CONTENT.features, LANDING_CONTENT.compare, LANDING_CONTENT.hero]).toLowerCase();
    expect(shipped).not.toMatch(/transitions?: coming soon|filters?: coming soon|no template library/);
    const timeline = LANDING_CONTENT.features.items.find((i) => i.id === "timeline");
    expect(timeline?.soonNote).toBeUndefined();
    expect(timeline?.body.toLowerCase()).toMatch(/transition/);
  });

  it("features templates: a section with four featured cards that exist, a nav link, and an honest own-template FAQ", () => {
    const { templates, nav, faq } = LANDING_CONTENT;
    expect(templates.featured).toHaveLength(4);
    for (const id of templates.featured) expect(getTemplate(id)).toBeDefined();
    expect(nav.links.map((l) => l.label)).toContain("Templates");
    const own = faq.items.find((f) => f.question.startsWith("Are templates free"));
    expect(own?.answer).toMatch(/parseTemplateJson/);
    expect(own?.answer).toMatch(/coming soon/);
    expect(own?.link?.href).toBe("https://github.com/Svector-anu/runitback/blob/main/docs/TEMPLATES.md");
  });

  it("references image files that exist in public/ with positive dimensions and alt text", () => {
    for (const shot of allShots()) {
      expect(existsSync(join(PUBLIC, shot.src))).toBe(true);
      expect(shot.width).toBeGreaterThan(0);
      expect(shot.height).toBeGreaterThan(0);
      expect(shot.alt.trim().length).toBeGreaterThan(10);
    }
    expect(LANDING_CONTENT.product.demo.src).toBe("/landing/demo.mp4");
    expect(existsSync(join(PUBLIC, LANDING_CONTENT.product.demo.poster))).toBe(true);
  });
});
