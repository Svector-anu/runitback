# 06 - Current rewrite vs Classic: state, gaps, build/deploy/conventions

Roots: CUR = `.../scratchpad/ref-current/repo`, CLS = `.../scratchpad/ref-classic/repo`.

## A. CURRENT rewrite (CUR): what exists vs what README promises

README (CUR/README.md) promises: Editor API, plugin-first architecture, desktop+mobile+browser from one Rust core, MCP server, headless/batch render, in-editor scripting tab. States "being rewritten from the ground up", classic is "the one to reach for today", rewrite served at new.opencut.app. No outside contributions accepted. Dev: `proto use`; `moon run web:dev` (:5173), `api:dev` (:8787), `desktop:dev`.

Reality: essentially a scaffold (~8.5k LOC total, most is shadcn UI + GPUI theme/components). **None of the promised features exist.**

### apps/web (TanStack Start + Vite 8 + React 19 + Tailwind 4, Cloudflare Workers)
- Routes: only `/` (`src/routes/index.tsx`: renders "hello world!") and `/editor` (`editor.tsx`: "Editor / Coming soon."). `__root.tsx` sets title "OpenCut rewrite | beta.opencut.app" (note: wrangler route is new.opencut.app - inconsistency), Playfair Display font, TooltipProvider, TanStack devtools.
- ~55 shadcn/ui primitives in `src/components/ui/` (base-ui + radix-ui, cmdk, vaul, sonner, recharts, react-hook-form, zod 4, hugeicons+lucide). No editor code, no state store, no timeline, no wasm.
- Tests: vitest configured (`bun run test`) but zero test files found (find for *.test.* returned none). Many deps use `"latest"` (@tanstack/*), unpinned.
- `wrangler.jsonc`: name `opencut-web`, compat date 2025-09-02, `nodejs_compat`, main `@tanstack/react-start/server-entry`, custom domain `new.opencut.app`. Subpath import alias `#/*` -> `./src/*` (classic uses `@/*`).
- `.cta.json` present (create-tanstack-app scaffold). `package.json` has a stray `pnpm.onlyBuiltDependencies`.

### apps/api (Elysia on Cloudflare Workers)
`src/index.ts` (13 lines): `GET /` -> `{status:"ok"}`, `GET /health` -> `{healthy, timestamp}`, `POST /echo` (body `{message:string}`). `.compile()` with CloudflareAdapter AoT. wrangler name `opencut-api`, compat 2025-06-01. Deps `elysia: latest`. No auth, DB, storage, or Editor API / MCP.

### apps/desktop (Rust + GPUI 0.2.2)
- `main.rs`: opens a maximized 960x600 window titled "OpenCut"; includes WSL workaround (removes WAYLAND_DISPLAY if WSL+X11+Wayland both set; GPUI 0.2.2 needs xdg_wm_base v2+, WSLg gives v1).
- `shell.rs`: layout = top row 2/3 height [Browser w-1/4 | Preview | Inspector] + Timeline bottom. Panels (`panels/{browser,preview,inspector,timeline}.rs`, ~20 lines each) are placeholders that render a centered label string. Entities created once in `Shell::new`.
- `theme.rs` (222 lines; colors incl. sidebar tokens, `window.theme()` via `ActiveTheme` trait), `components/` = badge, button, context_menu, label, resizable, separator (UI kit only).
- README: "Very early. Right now this is just a window that opens." Platform deps listed (macOS Xcode CLT/Metal; Windows none; Linux Vulkan+Wayland/X11 libs+cmake).
- Cargo workspace (`CUR/Cargo.toml`): resolver 3, edition 2024, members only `apps/desktop`; `'crates/*'` is COMMENTED OUT. gpui = "0.2.2".

### crates/media
Only `crates/media/setup/{setup.ts, ffmpeg.json}`. **No Rust source, no Cargo.toml, no build.rs** (comments reference a `build.rs` and `media:setup` moon task that don't exist in this snapshot). Purpose by design: FFmpeg 8.1.3 (LGPL-2.1+, shared builds) provisioned into `.cache/media/` for a decode crate. `ffmpeg.json` pins source tarball + sha256 and prebuilt BtbN builds for windows-x86_64/aarch64, linux-x86_64/aarch64 (macOS built from source only). `setup.ts` (Bun): downloads+sha256-verifies, `--from-source`, `--target <platform>`; cross build needs llvm-mingw (Windows) / Xcode (other Mac arch). (UNCERTAIN: I read only the head of setup.ts; the `crates/media` moon project has no moon.yml so `moon run media:setup` likely does not resolve yet.)

### Changelog (CUR/changelog/0.1.0.md, 0.2.0.md, 0.3.0.md)
These are the CLASSIC product's release notes (2026-02-23, 03-01, 04-15) carried over - not rewrite features. 0.3.0 "technical" entries are valuable archaeology of classic internals: ripple diff system `src/lib/ripple/`; `MediaTime` = integer ticks @ 120,000/s (23.976->5005, 29.97->4004, 30->4000 ticks/frame), `FrameRate` rational; `SceneTracks {overlay, main (singleton VideoTrack), audio}`; WebGL renderer replaced by Rust/wgpu compositor in WASM (compositor, effects, masks w/ JFA feathering, gpu, time); `src/types` + `src/constants` dissolved into `src/lib/`; packages/env & packages/ui folded into web; OpenNext Cloudflare deploy; storage migrations v9-v25. (Classic CLS tree now has top-level `src/<domain>/` dirs and migrations up to v30-to-v31 tests, i.e. even newer than changelog.)

### Tooling/CI (CUR)
- `.prototools`: moon 2.3.3, bun 1.3.11, rust 1.97.0. `.moon/workspace.yml` projects globs `apps/*`, `crates/*`. `.moon/toolchains.yml`: JS pkg mgr bun 1.3.11, rust.
- Per-app `moon.yml` tasks: web {dev, build(outputs dist), test, deploy(dep build)}, api {dev, build, deploy}, desktop {dev=cargo run, check, build=cargo build --release}. Dev tasks `runInCI:false`.
- Root `moon.yml` task `upload-logos`: pushes `brand/marks/*.svg` to R2 bucket (`R2_BUCKET=opencut-assets` from `.env.example`/`.env.local`) via wrangler `r2 object put --remote`.
- Workflows: `bun-ci.yml` = `moon ci` on ubuntu/windows/macos (push/PR to main, paths-ignore *.md). `media-deps.yml` = manual dispatch building FFmpeg for 6 platforms (llvm-mingw cross for Windows, pinned sha256) and publishing prerelease `ffmpeg-<ver>-<build>`; then `bun run crates/media/setup/pin.ts <tag>` (pin.ts NOT present in snapshot).
- Env: `.env.example` only `R2_BUCKET`. No DB/auth/redis envs.

## B. COMPATIBILITY GAPS (classic features absent or changed in CUR)
Everything user-facing is absent in CUR. Specifically:
1. Editor: timeline, tracks, preview canvas, properties panel, keyframes/graph editor, masks, effects (blur), blend modes, ripple, snapping, bookmarks, stickers, text/fonts (1000+ + system), canvas backgrounds, speed/volume, captions/transcription (HF transformers; transcript import), export (mediabunny), undo/redo/actions/keybindings, clipboard paste, project storage + 31 IndexedDB/localStorage migrations - none in CUR (only a "Coming soon" route).
2. Classic web routes missing in CUR: `/projects`, `/editor/[project_id]`, `/blog`, `/blog/[slug]`, `/changelog`, `/changelog/[version]`, `/roadmap`, `/brand`, `/contributors`, `/sponsors`, `/privacy`, `/terms`, `/rss.xml`, sitemap, robots, landing page.
3. Classic API routes (Next route handlers) missing: `/api/auth/[...all]` (better-auth), `/api/health`, `/api/feedback`, `/api/sounds/search` (Freesound). CUR api has only `/`, `/health` (different JSON shape: `{healthy,timestamp}`), `/echo`.
4. Backend: Postgres + Drizzle schema (CLS `apps/web/src/db/schema.ts`; only migration `0000_brainy_saracen.sql`: tables accounts, sessions, users, verifications, waitlist, RLS enabled, FKs cascade) and Upstash Redis rate limiting, BotID, Marble CMS blog - none in CUR.
5. Rust: CLS has 6 crates + wasm (`opencut-wasm` 0.2.10, published to npm and consumed by web) - bridge (`#[export]` proc-macro), compositor, effects, gpu, masks, time. CUR has no `rust/` tree and no wasm package; Cargo workspace excludes `crates/*`. The wgpu compositor/time code must be taken from CLASSIC.
6. Stack changed: Next 16 + Turbopack + Turbo + Drizzle/Postgres + OpenNext -> TanStack Start + Vite + Elysia + moon + Workers. Package manager bun 1.2.18 -> 1.3.11; TypeScript 5.8 -> 6; zod 4.3.6 -> 4.4; react-resizable-panels 2 -> 4; path alias `@/` -> `#/`.
7. Desktop: CLS `apps/desktop` has only `main.rs` + setup scripts; CUR adds shell/theme/component kit (still placeholders). CLS ran `cargo run -p opencut-desktop` and used `script/setup-rust` + `apps/desktop/script/setup`; CUR uses proto/moon.
8. Linting: CUR has no ESLint/Biome/Prettier config or custom rules at all; classic's `prefer-object-params` and no-unsafe-type-assertion rules are not carried over.
9. Hosting: classic `opencut.app` (Cloudflare via OpenNext or Docker); rewrite domain inconsistently named new.opencut.app (wrangler/README) vs beta.opencut.app (root title).
10. Docker/compose/self-host path does not exist in CUR.

## C. CLASSIC build / deploy / env / config (CLS)

### Workspace
- Root `package.json`: bun@1.2.18 workspaces `apps/*`, `packages/*` (packages/ dir absent). Scripts: `build:wasm` = `wasm-pack build rust/wasm --target bundler --out-dir pkg`; `dev:wasm` = cargo watch on rust/crates + rust/wasm/src; `publish:wasm`; `dev:web`/`build:web`/`deploy:web` via turbo `--filter=@opencut/web`; `lint:web` (eslint apps/web/src); `format:web` (prettier on `apps/web/src/services/renderer`); `generate:fonts` (`apps/web/scripts/generate-font-sprites.ts`); **`test` = `bun test`** (root; bun's native runner picks up `*.test.ts` and eslint rule test). `.npmrc`: `install-strategy="nested"`, `node-linker=isolated`. Root deps include better-auth, next 16, `opencut-wasm ^0.2.10`, TS 6, eslint 9.
- `turbo.json`: tasks build (deps ^build; outputs `.next/**` excluding cache; env list: NODE_ENV, NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_MARBLE_API_URL, DATABASE_URL, BETTER_AUTH_SECRET, UPSTASH_REDIS_REST_URL/TOKEN, MARBLE_WORKSPACE_KEY, FREESOUND_CLIENT_ID, FREESOUND_API_KEY), check-types, dev/preview (persistent, uncached), deploy, lint, lint:fix, format.
- `biome.json` exists (tabs, width 80, double quotes, recommended; organizeImports off) alongside ESLint+Prettier (`.prettierrc.json`); Biome vcs disabled. ESLint is the enforced linter in scripts/CI-intent; Biome presence is unclear whether used (UNCERTAIN).
- `apps/web` scripts: `dev` = `next dev --turbopack`; `build`; `start`; `preview`/`deploy` = `opennextjs-cloudflare build && preview|deploy`; `db:generate|migrate|push:local|push:prod` (drizzle-kit; `drizzle.config.ts` loads `.env.local` or `.env.production`, schema `./src/lib/db/schema.ts` [note: actual file is `src/db/schema.ts` - config path likely stale], dialect postgresql, migrations table `drizzle_migrations`, out `./migrations`, strict in prod).
- `next.config.ts`: `output: "standalone"`, removeConsole in prod, productionBrowserSourceMaps, wrapped with `withBotId` (botid) + `withContentCollections`; image remotePatterns: plus./images.unsplash.com, images.marblecms.com, lh3.googleusercontent.com, avatars.githubusercontent.com, api.iconify.design, api.simplesvg.com, api.unisvg.com, cdn.brandfetch.io. `content-collections.ts` for blog/changelog content.
- tsconfig alias `@/*` -> `./src/*`.

### Env (`apps/web/.env.example`, validated by zod in `src/env/web.ts` - build stubs needed)
NODE_ENV; NEXT_PUBLIC_SITE_URL (http://localhost:3000); NEXT_PUBLIC_MARBLE_API_URL (https://api.marblecms.com); DATABASE_URL (postgresql://opencut:opencut@localhost:5432/opencut); BETTER_AUTH_SECRET; UPSTASH_REDIS_REST_URL (http://localhost:8079) + _TOKEN (example_token); MARBLE_WORKSPACE_KEY; FREESOUND_CLIENT_ID; FREESOUND_API_KEY.

### docker-compose.yml
Services: `db` postgres:17 (user/pass/db opencut, :5432, pg_isready healthcheck), `redis` redis:7-alpine (:6379), `serverless-redis-http` hiett/serverless-redis-http (:8079->80, SRH_TOKEN example_token, SRH_CONNECTION_STRING redis://redis:6379), `web` (build `apps/web/Dockerfile`, :3100->3000, env as above incl. BETTER_AUTH_SECRET placeholder, healthcheck `curl -f http://localhost:3000/api/health`). Volume postgres_data; network opencut-network. Local dev: `docker compose up -d db redis serverless-redis-http` then `bun install && bun dev:web` -> :3000.

### Dockerfile (apps/web/Dockerfile)
Multi-stage `oven/bun:alpine`: builder copies package.json/bun.lock/turbo.json + apps/web, `bun install`, sets stub env to satisfy zod (DATABASE_URL etc.), build args FREESOUND_*, NEXT_PUBLIC_MARBLE_API_URL, MARBLE_WORKSPACE_KEY=build-placeholder; `bun run build`; runner copies `.next/standalone`, `.next/static`, `public`; user nextjs(1001); EXPOSE 3000; `CMD ["bun","apps/web/server.js"]`. Note builder does NOT build wasm; relies on published `opencut-wasm` npm package.

### Cloudflare (wrangler.jsonc root and apps/web, identical)
name `opencut`, main `.open-next/worker.js`, compat 2025-04-01, flags `nodejs_compat`+`global_fetch_strictly_public`, assets dir `.open-next/assets` binding ASSETS, service binding WORKER_SELF_REFERENCE -> `opencut`. `open-next.config.ts` = `defineCloudflareConfig()` (no R2 cache/queues configured).

### CI (`.github/workflows/bun-ci.yml`)
Matrix ubuntu/windows/macos; sets dummy env vars; installs wasm32 target + wasm-pack; caches cargo; `wasm-pack build rust/wasm --target bundler --out-dir pkg`; bun 1.2.18; `bun install` and `bun run build` in apps/web; test step is `echo "No tests implemented yet"` (continue-on-error) -> **CI does not run tests or lint**. Other .github: CONTRIBUTING.md, copilot-instructions.md (a11y/code-quality rules list, "AI-friendly"), PR template, issue templates, SECURITY/SUPPORT.

### Migrations
- Postgres: single drizzle migration `apps/web/migrations/0000_brainy_saracen.sql` (+ `meta/`).
- Client-side project storage migrations: `apps/web/src/services/storage/migrations/` with tests v0->v1 ... v30->v31 (fixtures v0-v3, v5). Keybindings migrations: `src/stores/keybindings/migrations/vN-to-vN+1.ts` per docs/actions.md (CLS docs reference `src/lib/...`/`src/stores/` paths that predate the flattening; actual tree has `src/actions`, `src/commands`, etc.).

### Rust
- `Cargo.toml` workspace resolver 2: apps/desktop, rust/crates/{time,bridge,effects,gpu,masks,compositor}, rust/wasm. `opencut-wasm` 0.2.10, edition 2024, crate-type cdylib+rlib, default feature `wasm`; deps wasm-bindgen 0.2.116, web-sys (OffscreenCanvas, HtmlCanvasElement, CanvasRenderingContext2d, Document, Window, Performance), serde-wasm-bindgen, console_error_panic_hook; crates `gpu` and `time` enable feature `wasm`.
- `rust/README.md`: new crate under `rust/crates/`, depend on `bridge`, annotate public fns with `#[export]`; without `wasm` feature the macro is a no-op, with it expands to `#[wasm_bindgen(js_name="camelCase")]` (e.g. `round_to_frame` -> `roundToFrame`); desktop uses crates directly; test with `cargo test -p <crate>`.
- `bridge.rs` proc-macro `#[export]` (fn and const only) **errors at compile time if an exported fn has >1 parameter**: must take a single options struct (mirrors TS prefer-object-params). 
- `rust/wasm/README.md`: published npm pkg; local dev via `bun run build:wasm`, `bun link` in `rust/wasm/pkg`, `bun link opencut-wasm` in apps/web, `bun dev:wasm`; revert with `bun add opencut-wasm`.
- Source files: compositor (blend_mode, compositor, frame, texture_pool, texture_store, shaders/), effects (effects, pipeline, types, shaders/), gpu (context, shaders/), masks (feather, masks, sdf, shaders/), time (frame_rate, media_time, time, timecode).

### Existing tests (CLS)
Runner: `bun test` (root). Files (all `__tests__/`): `eslint/rules/__tests__/prefer-object-params.test.mjs`; web `stickers/sticker-id`, `animation/animated-params`, `utils/math`, `fps/fps`, `timeline/update-pipeline`, `masks/snap`, `timeline/placement/resolve`, `retime/split`, `retime/resolve`, `params/channel-layout`, `actions/keybindings/persistence`; storage migrations v0-v1..v30-v31 (27 files; missing steps e.g. v6-v7, v7-v8, v9-v15, v17-v18, v23-v26 have no test; fixtures only v0,v1,v2,v3,v5; `helpers.ts`). Rust: tests via `cargo test -p <crate>` (not enumerated; UNCERTAIN whether any exist). No UI/component/e2e tests. A reconstruction should cover: time/frame math, retime, timeline placement/update-pipeline, animation params, masks snap, migrations chain, keybinding persistence, sticker IDs, lint rule.

## D. Conventions enforced by lint / tooling (CLS)
- `eslint.config.mjs` (flat, scoped to `apps/web/src/**/*.{ts,tsx}`): js recommended, typescript-eslint recommended (type-aware `projectService`), react recommended + jsx-runtime, react-hooks `recommended-latest`, jsx-a11y recommended, @next core-web-vitals, eslint-config-prettier; `reportUnusedDisableDirectives: error`; ignores .next/node_modules/dist/build.
- Custom rules: `opencut/prefer-object-params` = **error**; `@typescript-eslint/no-unsafe-type-assertion` = **error** (no `as` casts that narrow unsafely); `no-unused-vars` warn with `^_` ignore patterns (args, caught errors, destructured array, vars); `no-empty` warn; `no-empty-object-type` warn; `react/prop-types` off.
- `prefer-object-params` (eslint/rules/prefer-object-params.mjs): flags any function/arrow/function-expression with >1 params. Exemptions: (a) function passed directly as call/new argument (callbacks like `.map((a,i)=>...)`); (b) function nested in an inline option object literal passed to a call (e.g. zustand `persist(..., {migrate:(s,v)=>})`, better-auth `customStorage`); pre-declared option objects do NOT qualify; (c) type predicates (`x is Foo`). Suppress with `// eslint-disable-next-line` placed on function declaration line (loc is set to start at function's first line). Unit test in `eslint/rules/__tests__/`.
- Rust analog: `#[export]` rejects multi-arg fns (single options struct).
- Formatting: Prettier (`.prettierrc.json`, `format:web` only targets renderer dir) and biome.json (tabs, 80 cols, double quotes). Code style observed: tabs, double quotes.
- AGENTS.md (23 lines): business logic migrates into `rust/` ("single source of truth for all non-UI code; no components, hooks, framework imports"); `apps/` are UI shells that never own logic; web=Next.js, desktop=GPUI; web/React rule: read components before using them (they may already apply classes). copilot-instructions.md: a11y rules (button `type`, alt text, no positive tabIndex, etc.), complexity rules, "maximum type safety".
- docs/: actions.md (Action system: add to `ACTIONS` in definitions with category playback|navigation|editing|selection|history|timeline|controls, `defaultShortcuts`, optional `args`; new default shortcuts need a keybindings migration because they are persisted in localStorage), keyframes.md, effects-renderer.md, countries-search.md (not read in detail).

## E. Architectural philosophy (CLS notes/primitives-vs-domains.md)
- Smell: primitive value types living in domain folders (example: `Transform` in `apps/web/src/rendering/index.ts` consumed by timeline, preview, animation, text).
- Test: a type that can be described without mentioning clips, tracks, effects, layers, keyframes (no product concepts, no behavior beyond shape, no upward deps, multiple unrelated consumers, name fits any 2D editor) is a **primitive**; otherwise a domain type (TimelineElement, Effect, GraphicDefinition, MediaAsset).
- Why: dependency graph otherwise lies (timeline importing rendering just for Transform).
- Fix: move to a primitives location (`src/primitives/` or geometry/time/color), deliberately, one at a time, no bulk moves; collapse companion files parked next to the primitive (e.g. `rendering/animation-values.ts` -> `animation/values.ts`).
- Combined with AGENTS.md: UI = replaceable shell; logic = Rust; plugin-first/editor-API direction in CUR README.
- Domain-first folder layout in CLS `apps/web/src`: actions, animation, background, canvas, clipboard, commands, core, editor, effects, export, fonts, fps, gradients, graphics, guides, masks, media, panels, params, preview, project, rendering, retime, ripple, selection, services, sounds, speed, stickers, subtitles, text, timeline, transcription, utils, wasm (+ residual `types`, `db`, `auth`, `env`, `site`, `blog`, `changelog`).
