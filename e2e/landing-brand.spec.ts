import { test } from "@playwright/test";

/**
 * Opt-in generator for brand assets (`LANDING_BRAND=1 pnpm exec playwright test landing-brand`): the logo option
 * contact sheet (e2e/.artifacts, git-ignored), public/apple-touch-icon.png and public/og-image.png.
 * The chosen mark's geometry lives in src/ui/brand/Logo.tsx and public/favicon.svg; keep the three in sync.
 */
const ENABLED = process.env.LANDING_BRAND === "1";

const TILE = (glyph: string, bg = "#121212", ink = "#f0f0f0"): string =>
  `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="9" fill="${bg}"/>${glyph.replaceAll("INK", ink)}</svg>`;

const LOOP_PLAY = `<path d="M10.54 9.49A8.5 8.5 0 1 1 8.01 18.91" fill="none" stroke="INK" stroke-width="2.2" stroke-linecap="round"/><path d="M8.09 11.55 8.87 7.5 12.2 11.5Z" fill="INK" stroke="INK" stroke-width="1.2" stroke-linejoin="round"/><path d="M13.6 12.6v6.8l5.9-3.4Z" fill="INK" stroke="INK" stroke-width="1.2" stroke-linejoin="round"/>`;
const REWIND_PLAY = `<path d="M12 16 7 12.4v7.2Z" fill="INK" stroke="INK" stroke-width="1.6" stroke-linejoin="round"/><path d="M14.2 9.2v13.6L25.2 16Z" fill="INK" stroke="INK" stroke-width="1.6" stroke-linejoin="round"/>`;
const RETURN_PLAY = `<path d="M11.5 8.5v15l12-7.5Z" fill="INK" stroke="INK" stroke-width="1.6" stroke-linejoin="round"/><path d="M6.5 22.6c0-4.3 0-8.6 0-12.9" fill="none" stroke="INK" stroke-width="2.2" stroke-linecap="round"/>`;

const OPTIONS = [
  { key: "A", name: "Loop + play", svg: TILE(LOOP_PLAY), inverse: TILE(LOOP_PLAY, "#f0f0f0", "#121212") },
  { key: "B", name: "Rewind + play", svg: TILE(REWIND_PLAY), inverse: TILE(REWIND_PLAY, "#f0f0f0", "#121212") },
  { key: "C", name: "Playhead + play", svg: TILE(RETURN_PLAY), inverse: TILE(RETURN_PLAY, "#f0f0f0", "#121212") },
];

test.describe("landing brand assets (opt-in)", () => {
  test.skip(!ENABLED, "set LANDING_BRAND=1 to regenerate brand assets");
  test.use({ viewport: { width: 1200, height: 630 } });

  test("logo options contact sheet, apple touch icon and og image", async ({ page }) => {
    await page.goto("/fonts/inter.css");
    const css = `@font-face{font-family:"Host Grotesk";src:url("/fonts/host-grotesk-latin-wght-normal.woff2");font-weight:300 800}
      @font-face{font-family:"Geist Mono";src:url("/fonts/geist-mono-latin-wght-normal.woff2");font-weight:100 900}
      *{box-sizing:border-box;margin:0}body{font-family:"Host Grotesk",sans-serif;color:#121212}
      .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:32px;background:#f0f0f0;width:1200px}
      .opt{border:1px dashed rgba(0,0,0,.25);border-radius:24px;padding:24px;display:grid;gap:20px}
      .opt h3{font-size:18px;font-weight:600;letter-spacing:-.02em}.row{display:flex;align-items:center;gap:16px}
      .lock{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:600;letter-spacing:-.04em}
      .dark{background:#0c0c0c;color:#f0f0f0;border-radius:16px;padding:16px}
      .sz{display:flex;align-items:flex-end;gap:14px}.sz svg{display:block}`;
    const sheet = OPTIONS.map((o) => `<div class="opt"><h3>${o.key} · ${o.name}</h3>
      <div class="sz"><div style="width:96px">${o.svg}</div><div style="width:48px">${o.svg}</div><div style="width:32px">${o.svg}</div><div style="width:16px">${o.svg}</div></div>
      <div class="lock"><div style="width:32px">${o.svg}</div>RunItBack</div>
      <div class="dark"><div class="lock"><div style="width:32px">${o.inverse}</div>RunItBack</div></div></div>`).join("");
    await page.setContent(`<style>${css}</style><div class="sheet">${sheet}</div>`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".sheet").screenshot({ path: "e2e/.artifacts/landing/logo-options.png" });

    const chosen = OPTIONS[0]!.svg;
    await page.setViewportSize({ width: 180, height: 180 });
    await page.setContent(`<style>${css}body{background:#f0f0f0;width:180px;height:180px;display:grid;place-items:center}</style><div style="width:180px">${chosen}</div>`);
    await page.screenshot({ path: "public/apple-touch-icon.png" });

    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(`<style>${css}
      body{width:1200px;height:630px;background:#f0f0f0;position:relative;overflow:hidden}
      .frame{position:absolute;inset:28px;border:1.5px dashed rgba(0,0,0,.28);border-radius:36px;padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between}
      h1{font-size:92px;line-height:1;letter-spacing:-.035em;font-weight:600;max-width:900px}h1 span{color:#6b6b6b}
      .pill{display:inline-flex;align-items:center;gap:10px;border:1px dashed rgba(0,0,0,.35);border-radius:999px;padding:8px 18px;font-size:22px;font-weight:500}
      .dot{width:11px;height:11px;border-radius:50%;background:#00ba1f}
      .top{display:flex;justify-content:space-between;align-items:center}.lock{font-size:34px}
      .mono{font-family:"Geist Mono",monospace;font-size:20px;letter-spacing:.06em;text-transform:uppercase;color:#4f4f4f}
      </style><div class="frame"><div class="top"><div class="lock" style="display:flex;align-items:center;gap:12px;font-weight:600;letter-spacing:-.04em"><div style="width:44px">${chosen}</div>RunItBack</div><div class="pill"><i class="dot"></i>Free in your browser</div></div>
      <h1>Tell your video editor <span>what to do.</span></h1><div class="mono">private · open source · works in Chrome</div></div>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "public/og-image.png" });
  });
});
