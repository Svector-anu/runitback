import { expect, type Locator, type Page } from "@playwright/test";

export interface MobileViewport { name: string; width: number; height: number }

export const MOBILE_VIEWPORTS: ReadonlyArray<MobileViewport> = [
  { name: "360x740", width: 360, height: 740 },
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
];

export const MIN_TARGET_PX = 44;

/** Touch and mobile emulation. The spec files select real Chrome at top level (H.264 export needs it; `channel` cannot change per describe). */
export const mobileContext = (viewport: MobileViewport) => ({
  viewport: { width: viewport.width, height: viewport.height },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
});

export async function shot(page: Page, viewport: MobileViewport, name: string): Promise<void> {
  await page.screenshot({ path: `e2e/.artifacts/mobile/${viewport.name}/${name}.png` });
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
    scrollX: window.scrollX,
  }));
  expect(overflow.doc, "document wider than viewport").toBeLessThanOrEqual(0);
  expect(overflow.body, "body wider than viewport").toBeLessThanOrEqual(0);
  expect(overflow.scrollX).toBe(0);
}

export async function expectInsideViewport(page: Page, target: Locator): Promise<void> {
  const box = await target.boundingBox();
  const size = page.viewportSize();
  if (!box || !size) throw new Error("element or viewport has no box");
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.y).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 0.5);
}

export async function expectTouchTarget(target: Locator, label: string): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error(`${label} has no box`);
  expect(box.width, `${label} width`).toBeGreaterThanOrEqual(MIN_TARGET_PX - 0.5);
  expect(box.height, `${label} height`).toBeGreaterThanOrEqual(MIN_TARGET_PX - 0.5);
}

export interface Point { x: number; y: number }

type TouchPhase = "touchStart" | "touchMove" | "touchEnd";

/** Runs one gesture on a single CDP session: the browser tracks touch state per session. */
async function gesture(page: Page, run: (send: (type: TouchPhase, points: Point[]) => Promise<void>) => Promise<void>): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await run(async (type, points) => {
      await session.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
    });
  } finally {
    await session.detach();
  }
}

/** One-finger drag with real touch events, so pointer events and touch-action behave as on a phone. */
export async function touchDrag(page: Page, from: Point, to: Point, steps = 8): Promise<void> {
  await gesture(page, async (send) => {
    await send("touchStart", [from]);
    for (let i = 1; i <= steps; i++) {
      await send("touchMove", [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    }
    await send("touchEnd", []);
  });
}

/** Two-finger pinch around `center`: fingers go from `startGap` apart to `endGap` apart horizontally. */
export async function touchPinch(page: Page, center: Point, startGap: number, endGap: number, steps = 8): Promise<void> {
  const at = (gap: number): Point[] => [{ x: center.x - gap / 2, y: center.y }, { x: center.x + gap / 2, y: center.y }];
  await gesture(page, async (send) => {
    await send("touchStart", at(startGap));
    for (let i = 1; i <= steps; i++) await send("touchMove", at(startGap + ((endGap - startGap) * i) / steps));
    await send("touchEnd", []);
  });
}

export async function centerOf(target: Locator): Promise<Point> {
  const box = await target.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Opens a bottom-sheet tab, tolerating the sheet already showing it. */
export async function openSheet(page: Page, name: "Assets" | "Properties" | "Agent"): Promise<void> {
  const tab = page.getByRole("tablist", { name: "Panels" }).getByRole("tab", { name });
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.tap();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("mobile-sheet")).toHaveAttribute("data-tab", name.toLowerCase());
}

export async function closeSheet(page: Page): Promise<void> {
  if (await page.getByTestId("mobile-sheet").count() === 0) return;
  await page.getByTestId("mobile-sheet").getByRole("button", { name: /^Close .* panel$/ }).tap();
  await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);
}
