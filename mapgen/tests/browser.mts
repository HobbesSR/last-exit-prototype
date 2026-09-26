import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { readArtifact } from "../src/artifact.ts";
import { gridViews, segmentIndexAt } from "../src/core.ts";
import { tilePrimitives, segmentPlace } from "../src/primitives.ts";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
let playwright: any;
try {
  // Resolves from mapgen/node_modules or, failing that, the repository root's.
  playwright = require("@playwright/test");
} catch {
  throw Error(
    "Browser check needs @playwright/test; run npm ci at the repository root. Runtime itself has no dependencies.",
  );
}
// Port 0: other worktrees run this check concurrently, so no fixed port is safe.
const server = spawn(process.execPath, ["tools/server.mts", "--port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let browser: any;
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Server timeout")), 10000);
    let printed = "";
    server.stdout!.on("data", (chunk) => {
      printed += chunk;
      const url = /^(http:\/\/\S+)\r?\n/.exec(printed)?.[1];
      if (!url) return;
      clearTimeout(timer);
      resolve(url);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error(`Server exited ${code}`));
    });
  });
  browser = await playwright.chromium.launch({
    channel: "chrome",
    headless: true,
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e: Error) => {
    console.error("PAGE_ERROR:", e);
    errors.push(e.message);
  });
  page.on("console", (msg: any) => console.log("PAGE_LOG:", msg.text()));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window as any).mapLab?.snapshot().valid, {
    timeout: 30000,
  });
  assert.match(await page.locator("#status").innerText(), /Validated/);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/map-lab.png", fullPage: true });
  await page.locator("#overlay").selectOption("region");
  await page.screenshot({ path: "test-results/regions.png", fullPage: true });
  await page.locator("#overlay").selectOption("class");
  await page.screenshot({
    path: "test-results/region-class.png",
    fullPage: true,
  });
  await page.locator("#overlay").selectOption("tier");
  await page.keyboard.down("d");
  await page.waitForTimeout(500);
  await page.keyboard.up("d");
  await page.locator("#authorTab").click();
  // The preview resolves a pointer against the grid rather than against whatever
  // node sits under it, so segment checks address coordinates in cell units.
  const at = async (u: number, v: number) => {
    const box = (await page.locator("#tilePreview").boundingBox())!;
    return { x: box.x + (u / 6) * box.width, y: box.y + (v / 6) * box.height };
  };
  const poke = async (u: number, v: number, alt = false) => {
    const p = await at(u, v);
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.click(p.x, p.y);
    if (alt) await page.keyboard.up("Alt");
  };
  const dragBox = async (u0: number, v0: number, u1: number, v1: number) => {
    const a = await at(u0, v0),
      b = await at(u1, v1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
  };
  await page.locator("#cloneTemplate").click();
  assert.match(await page.locator("#libraryStatus").innerText(), /Duplicated/);

  // A new tile can be named rather than being stuck with a generated id.
  await page.locator("#tileId").fill("test-yard");
  await page.locator("#tileAdapter").uncheck();
  await page.locator("#saveTemplate").click();
  assert.match(await page.locator("#librarySource").inputValue(), /test-yard/);
  assert.equal(await page.locator("#template").inputValue(), "test-yard");
  // Tile weight has been completely removed from the data model.
  assert.equal(await page.locator("#tileWeight").count(), 0);
  await page.locator("#mapTab").click();
  await page.locator("#generate").click();
  assert.ok(
    (
      await page.evaluate(() => (window as any).mapLab.snapshot().templateUsage)
    )["test-yard"] > 0,
    "the rebuilt map uses the active edited library",
  );
  await page.locator("#authorTab").click();

  // The preview exposes every addressable segment. A perimeter wall and an
  // interior wall are targeted overrides, without rewriting unrelated edges.
  assert.equal(await page.locator("#tilePreview .tile-segment").count(), 84);
  await page.locator('#segmentBrushes button:has-text("wall")').click();
  await poke(0.5, 0);
  assert.equal(await page.locator("#segmentKind").inputValue(), "wall");
  await page.locator('#segmentBrushes button:has-text("partial")').click();
  await page.locator("#brushAperture").fill("0.2-0.8");
  await poke(1.5, 3);
  assert.equal(
    await page.locator("#segmentControls strong").innerText(),
    "h:3,1",
  );
  await page.locator("#saveTemplate").click();
  const segmented = JSON.parse(
    await page.locator("#librarySource").inputValue(),
  );
  const segmentTile = segmented.tiles.find((t: any) => t.id === "test-yard");
  assert.equal(segmentTile.primitives.segments["h:0,0"], "wall");
  assert.deepEqual(segmentTile.primitives.segments["h:3,1"], [0.2, 0.8]);
  await page.locator("#template").selectOption("plain");
  await page.locator("#template").selectOption("test-yard");
  // Alt picks up what is already there instead of stating something new.
  await poke(1.5, 3, true);
  assert.equal(await page.locator("#segmentKind").inputValue(), "partial");
  assert.equal(await page.locator("#segmentAperture").inputValue(), "0.2-0.8");
  // Invalid text cannot be silently saved, even after selecting another edge.
  await page.locator("#segmentAperture").fill("broken");
  await poke(0.5, 0, true);
  await page.locator("#saveTemplate").click();
  assert.match(
    await page.locator("#libraryStatus").innerText(),
    /Invalid partial aperture/,
  );
  await poke(1.5, 3, true);
  await page.locator("#segmentAperture").fill("0.2-0.8");
  await page.locator("#saveTemplate").click();
  await page.locator("#mapTab").click();
  await page.locator("#generate").click();
  assert.match(await page.locator("#status").innerText(), /^Validated/);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const downloaded = await downloadPromise;
  const rebuilt = readArtifact(await readFile(await downloaded.path()));
  const placed = rebuilt.tiles.find((tile) => tile.templateId === "test-yard");
  assert.ok(placed, "edited edge design is used after rebuilding");
  const actual = gridViews(rebuilt);
  for (const [index, declaration] of tilePrimitives(
    segmentTile,
    placed.orientation,
  ).segments) {
    const { vertical, line, offset } = segmentPlace(index);
    const worldIndex = segmentIndexAt(
      rebuilt,
      vertical,
      line + (vertical ? placed.x : placed.y),
      offset + (vertical ? placed.y : placed.x),
    );
    const actualSpan = actual.segmentOpen(worldIndex);
    const expectedSpan =
      declaration === "wall" ? null : (declaration as number[]);
    if (actualSpan) {
      actualSpan[0] = Math.round(actualSpan[0] * 1000) / 1000;
      actualSpan[1] = Math.round(actualSpan[1] * 1000) / 1000;
    }
    if (expectedSpan) {
      expectedSpan[0] = Math.round(expectedSpan[0] * 1000) / 1000;
      expectedSpan[1] = Math.round(expectedSpan[1] * 1000) / 1000;
    }
    assert.deepEqual(
      actualSpan,
      expectedSpan,
      "exported geometry honors the rotated authored edge",
    );
  }

  // A cell class is declared once, then offered everywhere.
  await page.locator("#authorTab").click();
  await page.locator("#newClass").fill("hut");
  await page.locator("#addClass").click();
  assert.match(
    await page.locator("#libraryStatus").innerText(),
    /^Library valid/,
  );
  assert.ok(
    await page.locator("#defaultCellClass option", { hasText: "hut" }).count(),
    "a declared class is offered as a default",
  );
  // An explicit primitive class remains visible even when it used to equal the
  // default, so changing that default cannot silently repaint the cell.
  const withExplicitCell = JSON.parse(
    await page.locator("#librarySource").inputValue(),
  );
  const explicitTile = withExplicitCell.tiles.find(
    (t: any) => t.id === "test-yard",
  );
  explicitTile.primitives ??= {};
  explicitTile.primitives.cells ??= {};
  explicitTile.primitives.cells["5,5"] = { class: "open" };
  await page
    .locator("#librarySource")
    .fill(JSON.stringify(withExplicitCell, null, 2));
  await page.locator("#applyLibrary").click();
  await page.locator("#template").selectOption("test-yard");
  await page.locator("#defaultCellClass").selectOption("hut");
  await page.locator("#saveTemplate").click();
  assert.equal(
    await page.locator("#tilePreview div").nth(35).getAttribute("title"),
    "5,5 · open",
    "an explicit old-default primitive class survives a default change",
  );
  await page.locator("#defaultCellClass").selectOption("open");
  await page.locator("#clearPaint").click();
  await page.locator("#saveTemplate").click();
  await page.locator("#brushes button", { hasText: "hut" }).click();
  for (const i of [0, 1, 6, 7])
    await page.locator("#tilePreview div").nth(i).click();
  await page.locator("#saveTemplate").click();
  const painted = JSON.parse(await page.locator("#librarySource").inputValue());
  const edited = painted.tiles.find((t: any) => t.id === "test-yard");
  assert.equal(
    edited.cells[0].slice(0, 2),
    "hh",
    "corner cells carry the mark",
  );
  assert.equal(edited.cells[5], "......", "unpainted rows stay default");
  assert.equal(edited.legend.h, "hut", "legend resolves the mark to the class");
  assert.ok(painted.cellClasses.hut, "the class is declared in the library");
  assert.equal(
    await page.locator("#tilePreview div").nth(0).getAttribute("title"),
    "0,0 · hut",
    "the reloaded tile shows the painted class",
  );

  // A class still painted by a tile cannot be removed out from under it.
  await page
    .locator("#classList .class-row", { hasText: "hut" })
    .locator("button")
    .click();
  assert.match(
    await page.locator("#libraryStatus").innerText(),
    /still painted by a tile/,
  );

  await page.locator("#clearPaint").click();
  await page.locator("#saveTemplate").click();
  assert.match(
    await page.locator("#libraryStatus").innerText(),
    /^Library valid/,
  );
  const cleared = JSON.parse(await page.locator("#librarySource").inputValue());
  assert.equal(
    cleared.tiles.find((t: any) => t.id === "test-yard").cells,
    undefined,
    "clearing the painting drops the cells block entirely",
  );
  // Every tile in the corpus is pickable as a picture, and the filter narrows
  // the gallery without disturbing what is being edited.
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    JSON.parse(await page.locator("#librarySource").inputValue()).tiles.length,
  );
  await page.locator('#tileGallery [data-tile="plain"]').click();
  assert.equal(await page.locator("#template").inputValue(), "plain");
  await page.locator("#tileFilter").fill("test-y");
  assert.equal(await page.locator("#tileGallery .tile-card").count(), 1);
  await page.locator("#tileFilter").fill("");
  await page.locator('#tileGallery [data-tile="test-yard"]').click();
  assert.equal(await page.locator("#template").inputValue(), "test-yard");

  // With only segments live the catch radius is half a cell, so a point four
  // tenths of a cell away from a line still resolves to that line.
  await page.locator('#editMode button[data-value="segments"]').click();
  await page.locator('#segmentBrushes button:has-text("wall")').click();
  await poke(2.4, 2.5);
  assert.equal(
    await page.locator("#segmentControls strong").innerText(),
    "v:2,2",
  );
  assert.equal(await page.locator("#segmentKind").inputValue(), "wall");
  // The same point is a cell once cells own the surface again.
  await page.locator('#editMode button[data-value="cells"]').click();
  await page.locator('#brushes button:has-text("hut")').click();
  await poke(2.4, 2.5);
  assert.equal(
    await page.locator("#tilePreview div").nth(14).getAttribute("title"),
    "2,2 · hut",
  );

  // A rectangle dragged between vertices walls a room in one gesture.
  await page.locator('#editMode button[data-value="segments"]').click();
  await page.locator('#editTool button[data-value="rect"]').click();
  await page.locator('#segmentBrushes button:has-text("wall")').click();
  await dragBox(1, 1, 5, 5);
  await page.locator("#saveTemplate").click();
  const roomed = JSON.parse(await page.locator("#librarySource").inputValue());
  const roomTile = roomed.tiles.find((t: any) => t.id === "test-yard");
  const outline = [
    ...[1, 2, 3, 4].flatMap((i) => [`h:1,${i}`, `h:5,${i}`]),
    ...[1, 2, 3, 4].flatMap((i) => [`v:1,${i}`, `v:5,${i}`]),
  ];
  for (const address of outline)
    assert.equal(
      roomTile.primitives.segments[address],
      "wall",
      `rectangle drag walls ${address}`,
    );
  assert.equal(
    roomTile.primitives.segments["h:3,3"],
    undefined,
    "the rectangle states its outline, not its inside",
  );

  // The same gesture fills a block of cells when cells own the surface.
  await page.locator('#editMode button[data-value="cells"]').click();
  await page.locator('#brushes button:has-text("market")').click();
  await dragBox(2.5, 0.5, 4.5, 1.5);
  await page.locator("#saveTemplate").click();
  const blocked = JSON.parse(await page.locator("#librarySource").inputValue());
  const blockTile = blocked.tiles.find((t: any) => t.id === "test-yard");
  const marketMark = Object.entries(
    blockTile.legend as Record<string, string>,
  ).find(([, name]) => name === "market")![0];
  for (const [col, row] of [
    [2, 0],
    [3, 0],
    [4, 0],
    [2, 1],
    [3, 1],
    [4, 1],
  ])
    assert.equal(
      blockTile.cells[row!][col!],
      marketMark,
      `the rectangle fills ${col},${row}`,
    );
  assert.notEqual(
    blockTile.cells[2][2],
    marketMark,
    "the rectangle stops at the cells the drag covered",
  );

  // A numbered strip beside the preview covers a whole row at once, and a
  // right-click offers the same choices at the cursor.
  await page.locator('#editTool button[data-value="paint"]').click();
  await page.locator('#editMode button[data-value="cells"]').click();
  await page.locator('#brushes button:has-text("hut")').click();
  await page.locator("#gutterRows button").nth(4).click();
  const strip = await at(3.5, 3.5);
  await page.mouse.click(strip.x, strip.y, { button: "right" });
  assert.ok(
    await page.locator("#cursorPalette").isVisible(),
    "right-click opens a palette at the cursor",
  );
  await page.locator('#cursorPalette button:has-text("Fill column")').click();
  assert.equal(await page.locator("#cursorPalette").count(), 0);
  await page.locator("#saveTemplate").click();
  const shaped = JSON.parse(await page.locator("#librarySource").inputValue());
  const shapedTile = shaped.tiles.find((t: any) => t.id === "test-yard");
  const hutMark = Object.entries(
    shapedTile.legend as Record<string, string>,
  ).find(([, name]) => name === "hut")![0];
  assert.equal(
    shapedTile.cells[4],
    hutMark.repeat(6),
    "the row strip paints the whole row",
  );
  for (const row of [0, 1, 2, 5])
    assert.equal(
      shapedTile.cells[row][3],
      hutMark,
      "the cursor palette fills the whole column",
    );
  await page.locator('#editMode button[data-value="both"]').click();
  await page.locator("#clearPaint").click();
  await page.locator('#segmentBrushes button:has-text("any")').click();
  await page.locator('#patterns button:has-text("Defer all")').click();
  await page.locator("#saveTemplate").click();
  assert.match(
    await page.locator("#libraryStatus").innerText(),
    /^Library valid/,
  );
  await page.screenshot({ path: "test-results/authoring.png", fullPage: true });
  await page.locator("#librarySource").fill("{broken");
  await page.locator("#applyLibrary").click();
  assert.doesNotMatch(
    await page.locator("#libraryStatus").innerText(),
    /^Library valid/,
  );
  await page.locator("#mapTab").click();
  await page.locator("#random").click();
  assert.equal(
    await page.evaluate(() => (window as any).mapLab.snapshot().valid),
    true,
  );
  await page.setViewportSize({ width: 560, height: 900 });
  await page.locator("#authorTab").click();
  assert.ok(
    await page.locator("#segmentControls").isVisible(),
    "small viewport retains segment controls",
  );
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Browser passed: generation, rendering, region overlays, movement, shooting input, the tile gallery, edit modes and the widened segment catch radius, rectangle drags, row strips and the cursor palette, cell and perimeter editing, active-library rebuild, invalid JSON, and mobile layout.",
  );
} finally {
  await browser?.close();
  server.kill();
}
