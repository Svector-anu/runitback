import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANDING_CONTENT, type ShotImage } from "../src/ui/pages/landing-content";

const PUBLIC = join(__dirname, "..", "public");
const SECTION_IDS = ["product", "features", "how-it-works", "faq"];

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
    expect(SECTION_IDS).toContain(LANDING_CONTENT.hero.secondaryCta.target);
    for (const column of LANDING_CONTENT.footer.columns) for (const link of column.links) if (link.target) expect(SECTION_IDS).toContain(link.target);
  });

  it("has unique feature ids, a full 12-column bento and the six agreed cards", () => {
    const items = LANDING_CONTENT.features.items;
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.map((i) => i.title)).toEqual(["Edit with words", "Find any moment", "Plan before it edits", "Private by design", "Real timeline", "Export MP4 or WebM"]);
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
    expect(faq.length).toBeGreaterThanOrEqual(6);
    for (const item of faq) {
      expect(item.question.trim().endsWith("?")).toBe(true);
      expect(item.answer.trim().length).toBeGreaterThan(20);
    }
    const questions = faq.map((f) => f.question).join(" | ");
    for (const topic of ["uploaded", "cost", "browsers", "models", "Understand download", "open source"]) expect(questions).toContain(topic);
  });

  it("does not claim an open source licence, ratings, customers or metrics", () => {
    const text = JSON.stringify(LANDING_CONTENT).toLowerCase();
    expect(text).not.toMatch(/mit licen|apache|gpl|trusted by|\d+k\+? users|rated \d|testimonial|stars/);
    const openSource = LANDING_CONTENT.faq.items.find((f) => /open source/i.test(f.question));
    expect(openSource?.answer).toMatch(/not yet|soon/i);
  });

  it("marks unfinished work as coming soon and does not promise transitions or filters as shipped", () => {
    const timeline = LANDING_CONTENT.features.items.find((i) => i.id === "timeline");
    expect(timeline?.soonNote).toMatch(/coming soon/i);
    expect(timeline?.body.toLowerCase()).not.toMatch(/transition|filter/);
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
