# Landing page: where everything lives

The landing page is `/` (the real pathname, no hash). The app is `/app` and `/#/projects`. The visual language follows the owner's Zenon reference, measured in `docs/LANDING_RESEARCH.md`.

## Map

| What | File |
| --- | --- |
| All copy, links, FAQ, feature cards, steps, image paths | `src/ui/pages/landing-content.ts` (the only file a non-engineer needs) |
| Lazy entry (keeps the landing out of the editor bundle) | `src/ui/pages/Landing.tsx` |
| Section order (one line per section) | `src/ui/pages/landing/LandingPage.tsx` |
| Sections | `src/ui/pages/landing/` : `Nav`, `Hero`, `WorksWith`, `Product`, `Templates`, `Features`, `How`, `Plan`, `Compare`, `OpenSource`, `Faq`, `FinalCta`, `Footer` |
| Shared bits (arrow icons, eyebrow, section header, anchor handling) | `src/ui/pages/landing/parts.tsx` |
| Scroll reveal | `src/ui/pages/landing/use-reveal.ts` (IntersectionObserver, no dependency) |
| Page layout CSS (prefix `lp-`) | `src/ui/styles/landing.css` |
| Reusable visual language (prefix `zn-`) | `src/ui/styles/zenon-tokens.css` |
| Logo | `src/ui/brand/Logo.tsx`, `public/favicon.svg` |
| Images | `public/landing/*.webp` |
| Fonts | `public/fonts/host-grotesk-*.woff2`, `geist-mono-*.woff2` (OFL, see `docs/SUPPLY_CHAIN.md`) |
| Tests | `e2e/landing-page.spec.ts`, `e2e/landing-app-split.spec.ts`, `e2e/ux-guidance.spec.ts`, `tests/landing-content.test.ts` |
| Generators (opt-in) | `e2e/landing-shots.spec.ts` (product screenshots), `e2e/landing-brand.spec.ts` (logo sheet, apple-touch-icon, og-image) |

Section anchors: `#product`, `#templates`, `#features`, `#how-it-works`, `#compare`, `#open-source`, `#faq`. Anchor clicks are intercepted and scrolled by `scrollToSection`; they must never write `location.hash`, because `App.tsx` treats any non-empty hash on `/` as an app route and would unmount the landing page.

## Positioning and messaging (open source, CapCut alternative)

Owner decision: RunItBack launches as open source under the MIT license (repo `https://github.com/Svector-anu/runitback`, private until the owner makes it public; the star and README, CONTRIBUTING, LICENSE links work from then on). Positioning: the open-source CapCut alternative with an AI agent.

Headline options considered:

1. The open-source video editor you can just talk to (now the footer tagline)
2. The open-source CapCut alternative. Tell your video editor what to do. (chosen)
3. Don't use CapCut again (rejected: reads as an attack, fails the do-not-disparage rule)
4. Edit video by describing it. Free, open source, in your browser.

Chosen: the h1 is a small first line (`hero.kicker`, "The open-source CapCut alternative") plus the large line "Tell your video editor what to do" (`hero.headline`). The CapCut-alternative line gives the stranger the category in one glance, and the large line keeps the plain-English promise. The phrase "Tell your video editor what to do" stays inside the h1 because `landing-app-split` and `ux-guidance` specs locate the heading by that text. Status pill: "Open source · MIT".

New content fields in `landing-content.ts`: `github` (repo, starLabel, readme, contributing, license, notice, issues), `license`, `trademarkNote` (rendered in the footer, verbatim), plus the `compare` and `openSource` sections. Star affordances (all plain links, `target=_blank rel="noopener noreferrer"`, star icon is inline SVG): nav pill (icon only between 901 and 1240 px, in the menu on mobile), hero secondary CTA, Open source panel, final CTA, footer column.

No live star count: the CSP `connect-src` does not allow `api.github.com` and the page must not call third parties. To add one later, fetch the count at build time (a script in `tools/` that writes `public/landing/stars.json`, run before `vite build`, rendered by the nav pill), or add `https://api.github.com` to `connect-src` in `vercel.json` and `index.html` deliberately and accept the runtime call. Never hard-code a number.

### CapCut facts used (verified in real Chrome, 12 October 2026)

Sources: `https://www.capcut.com/` and `https://www.capcut.com/pricing`.

- Products listed on the home page: CapCut Desktop, CapCut Online, CapCut Pad, CapCut Mobile. Used for "Runs in your browser: yes (CapCut Online), also desktop apps" and "Mobile app: yes, on mobile, tablet and desktop".
- Pricing page: a Free plan ("Free templates to start fast", "Basic editing tools") and paid Pro, Ultra and Teams plans. Used for "A free plan, plus paid Pro, Ultra and Teams plans". No prices, credit counts or limits are quoted (they vary by region and change).
- Home page: "Templates for Everything", AI editing tools, auto captions, caption templates, an AI video editor chat. Used for "A large library of templates, effects and AI tools" and "AI tools that generate and edit".
- Feature naming learned from the pages (names only, no copy reused): "Auto captions", "Caption templates", "Remove video BG", "Enhance voice", "Try online for free" as CTA, feature grids grouped by Image / Video / Text & Audio / Creative Templates. OpenCut (opencut.app) pairs a short "The open source video editor" headline with a "Try early beta" CTA and a star pill in the nav.
- Not asserted, because not verified: CapCut's data handling and privacy (the table says "Check CapCut's privacy policy"), whether its source is published (the table says "No", based on it being a commercial product with a License Agreement page; recheck before launch), exact prices and limits, how its AI editing works.
- Re-check these before each release; the page carries "checked on 12 October 2026" in `compare.checked`.

## Templates on the landing and the /templates page

`/templates` is a second marketing pathname, added the way `/app` was: `showGallery` in `src/App.tsx`, a rewrite in `vercel.json`, a lazy entry `src/ui/pages/TemplatesPageEntry.tsx` (the gallery is its own chunk). `/#/templates` reaches the same page (route `templates` in `src/app/router.ts`). The landing has a `Templates` section after the product shot (`landing/Templates.tsx`, four featured posters from `templates.featured` in `landing-content.ts`, link to `/templates`), a nav link, a hero text link, a feature card and an FAQ item about making your own template (importing your own is "coming soon"). The gallery reuses `Nav` with plain page links (`pageLinks`) because section anchors do not exist there. Gallery details: `docs/TEMPLATES.md` (UI).

## Change copy

Edit `landing-content.ts`. Everything visible is a string or array there: hero text, nav links, trust line, the six feature cards (`features.items`), the five steps (`how.steps`), the plan panel bullets, FAQ entries (`faq.items`), footer columns. `tests/landing-content.test.ts` guards the shape: headline, step names (the e2e specs match them), FAQ topics, section targets, image files exist, MIT and GitHub fields consistent, the verbatim trademark note, CapCut marked ahead where it is, no customer, rating, metric or star-count claims. Honesty rule: describe only what ships; unfinished items take `soonNote` ("... coming soon"). Do not add logos, ratings, testimonials or numbers unless they are real.

## Remove a section

Delete its line in `LandingPage.tsx` (and its nav link in `landing-content.ts` `nav.links` / `footer.columns` if it had an anchor; the content test fails when a link targets a missing section id). The numbered eyebrows (`/ 003 / FEATURES`) are set per section in the section file: renumber if you care.

## Add a section

1. Add its copy as a typed field in `landing-content.ts` (extend `LandingContent`).
2. Create `src/ui/pages/landing/MySection.tsx`: wrap in `<section className="lp-section lp-wrap" aria-labelledby="...">`, use `SectionHead` for the eyebrow, title and intro, add class `zn-reveal` and `style={stagger(i)}` to anything that should fade in.
3. Add `<MySection />` in `LandingPage.tsx` where it belongs.
4. If it needs a nav anchor, give the section `id` and `tabIndex={-1}`, add the id to `SectionId` in the content file and a `nav.links` entry.
5. Layout CSS goes in `landing.css` with the `lp-` prefix; reuse `zn-frame`, `zn-surface`, `zn-dark`, `zn-tag`, `zn-btn` from the tokens file.

## Swap the hero image, product shots and demo video

- Hero strip and product shots are `public/landing/*.webp` referenced from `landing-content.ts` (`hero.strip`, `product.shotLight/shotDark`, `plan.image`, `finalCta.image`). Replace the file or point to a new one and update `width`/`height` (prevents layout shift) and `alt`. For the strip, `ratio` is the card width/height and `position` the crop.
- Regenerate from the real editor: `LANDING_SHOTS=1 PLAYWRIGHT_PORT=5279 pnpm exec playwright test landing-shots` writes PNGs to `e2e/.artifacts/landing/shots/`; convert with `cwebp -q 82 -resize 1800 0 in.png -o public/landing/editor-light.webp` (card crops: see the commands in the spec header comment; widths used: 1800 editors, 900 preview, 800 plan, 1200 timeline).
- Demo video: put an MP4 (H.264 + AAC, ideally under 8 MB, 16:10) at `public/landing/demo.mp4`. The slot in `Product.tsx` (comment `DEMO VIDEO SLOT`) is a `<video controls preload="metadata">` with the poster from `product.demo.poster`. While the file is missing or not playable the slot is collapsed (`data-ready="false"`, hidden from assistive tech) and the page looks exactly as without it; once metadata loads it appears under the editor frame. Autoplay is deliberately off. CSP already allows it (`media-src 'self'`). Add captions as `<track>` if the video has speech.

## Theme, motion, accessibility

- Dark and light use the app's `data-theme` (`setTheme` persists it). `.zn` tokens switch in `zenon-tokens.css` under `:root[data-theme="dark"] .zn`.
- Reveals: 520 ms `cubic-bezier(0.22, 1, 0.36, 1)`, 105 ms stagger, 18 px rise (values measured from the reference). `prefers-reduced-motion` disables reveals, hover transforms and smooth scrolling; content is simply visible.
- Landmarks: skip link, `header`, `main`, `footer`; one `h1`, `h2` per section, `h3` inside cards; FAQ is buttons with `aria-expanded`/`aria-controls` and Arrow/Home/End navigation; decorative card illustrations are `aria-hidden`; every image has alt text.
- Mobile: under 900 px the nav collapses to logo, `Start editing`, menu button; theme toggle moves into the menu. Verified at 390 and 360 px (no horizontal scroll).

## Add a page (for example `/pricing`, `/changelog`)

The app has two routers: the landing is chosen by `location.pathname === "/"` in `src/App.tsx`, the app shell by `parseRoute` (hash routes) in `src/app/router.ts`. A new marketing page is a new pathname, mirroring how `/app` works:

1. Create `src/ui/pages/landing/PricingPage.tsx` (compose `Nav`, a section, `Footer`; import `../../styles/zenon-tokens.css` and `landing.css`; wrap in `<div className="zn lp">`). Keep it lazy (`lazy(() => import(...))`) so it stays out of the editor chunk.
2. In `src/App.tsx` next to `showLanding`, add `const showPricing = location.pathname === "/pricing"` and render the page before the app-shell switch (same pattern as `showLanding`; also exclude it from the `errorKey` logic like the landing).
3. Add the Vercel rewrite in `vercel.json` (see below).
4. Add copy to `landing-content.ts` (or a sibling content file) and a link in `nav.links` / `footer.columns` (`href: "/pricing"`; plain path links do a full page load, which is fine).
5. Add an e2e in `e2e/landing-*.spec.ts` and extend `e2e/landing-app-split.spec.ts` with the new pathname.

Hash links to the editor (`/#/projects`, `/#/editor/<id>`) keep working because the app shell only runs when the pathname is not a marketing page or the hash is non-empty.

## SEO and meta

`index.html` carries the title, description, `theme-color`, Open Graph and Twitter tags. Image: `public/og-image.png` (1200x630, generated by `landing-brand.spec.ts`), icons `public/favicon.svg` and `public/apple-touch-icon.png`. Edit `index.html` for text changes. Note the OG image URL is relative (`/og-image.png`): most scrapers need an absolute URL, so when the production domain is known change `og:image` and `twitter:image` to `https://<domain>/og-image.png` and add `og:url` and `<link rel="canonical">`. The tags apply to every route because the app is a single HTML file; per-page titles for new pages can be set in the page component (`document.title`).

## Vercel

`vercel.json` today rewrites only `/app` to `/index.html`; `/` is served as the index file and needs nothing. For every new pathname page add an entry before the headers block:

```json
{ "source": "/pricing", "destination": "/index.html" }
```

Do not add a catch-all `/(.*)` rewrite: it would hide missing static files (fonts, `/landing/demo.mp4`) behind the HTML shell, and the demo slot relies on a missing file failing. The CSP in `vercel.json` already covers the landing: `font-src 'self'` (fonts are self-hosted), `img-src 'self' data:` (grain overlay is an inline SVG data URI), `media-src 'self'` (demo video), `style-src 'self'` (the page uses CSS files and CSSOM styles, no inline `<style>`). No third-party scripts or styles are used.

## Brand

Mark: a play triangle inside a replay loop on a rounded tile ("run it back"). Chosen from three options (`e2e/.artifacts/landing/logo-options.png`, git-ignored; regenerate with `LANDING_BRAND=1 PLAYWRIGHT_PORT=5279 pnpm exec playwright test landing-brand`):

- A, loop + play: reads as "replay", literally the product name, distinctive silhouette. Chosen.
- B, rewind + play: reads as fast-forward, the wrong meaning.
- C, playhead + play: clean at 16 px but generic (looks like "skip to start").

Rationale for A: the name is an instruction to rerun footage, the loop arrow says that without text, and it survives at 16 px (favicon) because the ring and triangle are thick strokes on a solid tile. The favicon uses a slightly heavier ring (2.4 vs 2.2).

Files: `src/ui/brand/Logo.tsx` (`<Logo variant="mark" | "lockup" size={n} />`; the tile follows `currentColor`, the glyph follows `--logo-ink`, default the page background, so it inverts with the theme), `public/favicon.svg` (own light/dark via `prefers-color-scheme`), `public/apple-touch-icon.png` (180 px), `public/og-image.png`. The editor header uses the mark (`src/ui/editor/Header.tsx`).

Colours: ink `#121212` tile with `#f0f0f0` glyph on light; inverted on dark; accent `#f24202` is reserved for action circles, never the logo. Wordmark: "RunItBack" in Host Grotesk 600, tracking -0.04em, no space, capital R, I and B. Clear space: at least half the tile edge on every side; minimum size 16 px for the mark, 96 px wide for the lockup. To swap the logo: edit the three paths in `Logo.tsx`, the same three paths in `public/favicon.svg` and in `e2e/landing-brand.spec.ts` (`LOOP_PLAY`, option A), then run the brand generator to refresh the apple-touch icon and OG image.

## Zenon-style tokens for the editor shell

`src/ui/styles/zenon-tokens.css` is import-safe: every rule is scoped under `.zn` (it sets no global style). To adopt in the editor, put `class="zn"` on the shell root and import the file. Index of classes:

| Class | Purpose |
| --- | --- |
| `.zn` | scope: tokens (`--zn-page #f0f0f0`, `--zn-surface #e5e5e5`, `--zn-ink #121212`, `--zn-soft #4f4f4f`, `--zn-dark #080808`, `--zn-line` dashed hairline, `--zn-accent #f24202`, `--zn-ok #00ba1f`), fonts, film-grain overlay (`::after`, fixed, pointer-events none), dark theme overrides |
| `.zn-frame` | dashed 1 px frame, 24 px radius, 8 px padding |
| `.zn-surface` | filled card, 20 px radius |
| `.zn-dark` | near-black panel with on-dark colours and 28 px radius |
| `.zn-tag` + `.zn-dot` | status pill with green dot |
| `.zn-eyebrow` | numbered section label |
| `.zn-h1` `.zn-h2` `.zn-h3` `.zn-lead` `.zn-mono` | type scale (Host Grotesk 600, -0.03em / -0.025em / -0.02em; Geist Mono micro labels) |
| `.zn-btn` `--primary` `--secondary` `--light` `--sm` + `.zn-btn__circle` | pill buttons; the circle holds the arrow |
| `.zn-icon-btn` `--ink` | 42 px round icon buttons |
| `.zn-rule` | dashed divider |
| `.zn-reveal` | scroll-reveal target (`.is-in` set by `useReveal`) |

Tuning knobs: `--zn-grain-opacity`, `--zn-gutter`, `--zn-reveal-ms`, `--zn-stagger-ms`, `--zn-ease`. The editor currently keeps its own tokens (`tokens.css`); `.zn` redefines `--background` only inside its scope.

## Known leftovers

`src/ui/styles/editor.css` still contains the old `.landing*` rules (lines near 188-238) from the previous landing page; nothing references them now. They are outside the landing ownership and were left in place: delete them in the next editor-CSS pass.
