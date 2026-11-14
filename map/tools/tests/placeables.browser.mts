/** Independent Placeables tab acceptance; run from the repository root. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { DEFAULT_CELL_SIZE } from "../../engines.ts";
import { PLACEABLES } from "../../micro/placeables/index.ts";
// @ts-expect-error The test helpers are JavaScript without declarations.
import { collectBrowserErrors, serveDevWithBrowser } from "../../../tests/helpers/browser.js";

const OUT = "test-results/map-lab";
await mkdir(OUT, { recursive: true });
const { base: gameUrl, browser, close } = await serveDevWithBrowser({ strictProtocol: false });
const base = gameUrl + '/dev/map';
try {
  // The Placeables tab (#433, 20.8): every registered placeable, each example previewed, and
  // parameters edited within their specs, with errors and refusals shown in place of a preview.
  const placeablesPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const placeableErrors: string[] = [];
  collectBrowserErrors(placeablesPage, placeableErrors);
  await placeablesPage.goto(base, { waitUntil: "domcontentloaded" });
  await placeablesPage.locator("#placeablesTab").click();
  const view = placeablesPage.locator("#placeablesView");
  assert.equal(await view.isVisible(), true);
  assert.equal(await placeablesPage.locator("#worldView").isVisible(), false);
  /** Whether a canvas has anything drawn on it. */
  const painted = (canvas: any) => canvas.evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
    return false;
  });
  for (const [id, placeable] of Object.entries(PLACEABLES)) {
    await view.locator(`[data-placeable="${id}"]`).click();
    assert.match(await view.locator(".placeable-title").innerText(), new RegExp(`^${id} ${placeable.version}$`));
    const thumbs = view.locator(".placeable-examples canvas");
    assert.equal(await thumbs.count(), placeable.examples.length, `${id} previews each example`);
    for (let i = 0; i < placeable.examples.length; i++) assert.equal(await painted(thumbs.nth(i)), true, `${id} example ${i + 1} is drawn`);
    assert.equal(await painted(view.locator(".placeable-preview")), true, `${id} is previewed`);
    assert.equal(await view.locator("[name]").count(), placeable.params.length, `${id} edits each parameter`);
    const example = placeable.build(placeable.examples[0], DEFAULT_CELL_SIZE);
    assert.ok(!('refused' in example), `${id} has a buildable first example`);
    assert.ok((await view.locator(".readout").innerText()).startsWith(
      `Demand: body ${example.demand.body.w} × ${example.demand.body.h} cells`), `${id} shows its exact demand, including fractional cells`);
  }
  await view.locator('[data-placeable="house"]').click();
  assert.match(await view.locator(".readout").innerText(), /, clear \d+ × \d+ at \(/, "a house demands its doorstep");
  // An edit updates the readout, preview and JSON in place: the control keeps focus, and an
  // open disclosure stays open.
  await view.locator("details summary").click();
  await view.locator('[name="w"]').focus();
  await placeablesPage.keyboard.press("ArrowUp");
  assert.equal(await placeablesPage.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name), "w");
  assert.equal(await view.locator("details").evaluate((d: HTMLDetailsElement) => d.open), true);
  assert.match(await view.locator("details pre").innerText(), /"w": 5/);
  await view.locator('[name="w"]').fill("99");
  assert.match(await view.locator(".readout.invalid").innerText(), /house w must be a whole number from 3 to 12\./);
  assert.equal(await view.locator(".placeable-preview").isVisible(), false, "no preview the specs don't allow");
  await view.locator('[name="w"]').fill("4");
  await view.locator('[name="h"]').fill("5");
  await view.locator('[name="spaces"]').fill("3");
  assert.match(await view.locator(".readout.invalid").innerText(), /A house of 3 spaces needs at least 27 cells\./);
  await view.locator('[name="spaces"]').fill("2");
  assert.match(await view.locator(".readout.invalid").innerText(), /^Refused: no 2-space house fits 4 × 5/);
  assert.equal(await view.locator(".placeable-examples button.active").count(), 0);
  await view.locator(".placeable-examples button").nth(2).click();
  assert.equal(await view.locator(".placeable-examples button.active").count(), 1);
  assert.equal(await view.locator('[name="w"]').inputValue(), String(PLACEABLES.house!.examples[2].w), "an example's values show in the controls");
  assert.equal(await view.locator("details").evaluate((d: HTMLDetailsElement) => d.open), true);
  assert.equal(await painted(view.locator(".placeable-preview")), true);
  await view.locator('[data-placeable="warehouse"]').click();
  assert.match(await view.locator(".readout").innerText(), /warehouse: \d+ spaces?, /, "a building placeable reads as its trace");
  for (const width of [1440, 1180]) {
    await placeablesPage.setViewportSize({ width, height: 900 });
    await placeablesPage.waitForFunction(() => {
      const c = document.querySelector(".placeable-preview") as HTMLCanvasElement;
      return c.width === Math.round(c.clientWidth * devicePixelRatio);
    });
    const catalogue = await view.locator(".chain-sidebar").boundingBox();
    const preview = await view.locator(".placeable-preview").boundingBox();
    const inspector = await view.locator(".placeable-inspector").boundingBox();
    assert.ok(catalogue.x + catalogue.width <= preview.x && preview.x + preview.width <= inspector.x, "placeable preview sits between catalogue and placement information");
    assert.ok(inspector.x + inspector.width <= width && preview.y + preview.height <= 900, "selected placeable stays visible on desktop");
    assert.equal(await painted(view.locator(".placeable-preview")), true, "preview repaints after resize");
    const examplesHeading = await view.getByRole("heading", { name: "Examples", exact: true }).boundingBox();
    const exampleCard = await view.locator(".placeable-examples button").first().boundingBox();
    assert.ok(examplesHeading.y >= preview.y + preview.height && exampleCard.y + exampleCard.height <= 900, "examples heading and first card remain visible with the preview");
    await placeablesPage.screenshot({ path: `${OUT}/placeable-workspace-${width}.png` });
  }
  const previewParams = await view.locator("details pre").textContent();
  await placeablesPage.locator("#chainTab").click();
  await placeablesPage.locator("#placeablesTab").click();
  assert.match(await view.locator(".placeable-title").innerText(), /^warehouse /);
  assert.equal(await view.locator("details pre").textContent(), previewParams, "placeable selection and parameters survive tab changes");
  // A number parameter's spec bounds it but sets no granularity.
  await view.locator('[data-placeable="cover-piece"]').click();
  assert.equal(await view.locator('[name="length"]').getAttribute("step"), "any");
  await placeablesPage.screenshot({ path: `${OUT}/placeables.png`, fullPage: true });
  await placeablesPage.setViewportSize({ width: 390, height: 900 });
  assert.equal(await placeablesPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll at phone width");
  await placeablesPage.screenshot({ path: `${OUT}/placeables-mobile.png`, fullPage: true });
  assert.deepEqual(placeableErrors, []);
  await placeablesPage.close();

  console.log("Placeables browser acceptance passed.");
} finally {
  await close();
}
