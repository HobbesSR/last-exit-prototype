/**
 * The Map Lab in a browser (53, "Tools"). It generates chain maps through the tools' core,
 * so its saves must equal the core's own for the same seed, and a save it reads back must
 * show the same map. Run from the repository root: `node map/tools/tests/lab.browser.mts`.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { CHAIN_LIBRARY, checkMap, generate } from "../core.ts";
import { chainMapToBson, chainMapToJson } from "../../macro/src/chain/saving.ts";

const require = createRequire(import.meta.url);
let playwright: any;
try {
  playwright = require("@playwright/test");
} catch {
  throw Error("The Map Lab's browser check needs @playwright/test; run npm ci at the repository root.");
}
const OUT = "test-results/map-lab";
await mkdir(OUT, { recursive: true });
// Port 0: other worktrees run this check concurrently, so no fixed port is safe.
const server = spawn(process.execPath, ["map/tools/server.mts", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
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
  browser = await playwright.chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const snapshot = () => page.evaluate(() => (window as any).mapLab.snapshot());
  /** Wait until the lab shows a map for `seed`, or has failed. */
  const shown = async (seed: string) => {
    await page.waitForFunction((s: string) => {
      const lab = (window as any).mapLab?.snapshot();
      return lab && !lab.busy && (lab.seed === s || lab.error);
    }, seed, { timeout: 60000 });
    const lab = await snapshot();
    assert.equal(lab.error, "", `the lab failed: ${lab.error}`);
    return lab;
  };
  const save = async (button: string, name: string) => {
    const download = page.waitForEvent("download");
    await page.locator(button).click();
    const path = `${OUT}/${name}`;
    await (await download).saveAs(path);
    return path;
  };
  const generateIn = async (seed: string) => {
    await page.locator("#seed").fill(seed);
    await page.locator("#generate").click();
    return shown(seed);
  };

  // A game map from the chain's library, on load.
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const first = await shown("last-exit-001");
  const reference = generate("last-exit-001");
  const referenceCheck = checkMap(reference);
  assert.equal(first.params.mode, "game");
  assert.equal(first.regions, reference.results.length);
  assert.equal(first.briefs, reference.results.length);
  assert.equal(first.builtRegions, reference.results.length);
  assert.ok(first.portals > 0 && first.shapes > 0 && first.sites > 0, "portals, geometry and sites are drawn");
  assert.equal(first.report.valid, referenceCheck.valid);
  assert.deepEqual(first.report.coreElements, referenceCheck.coreElements);
  assert.match(await page.locator("#reportBody").innerText(), /No defects found/);
  await page.screenshot({ path: `${OUT}/world.png` });

  // Every view of the map, as the cell field.
  for (const field of ["resolved", "declared", "proof", "zones", "none", "regions"]) {
    await page.locator("#field").selectOption(field);
    await page.screenshot({ path: `${OUT}/field-${field}.png` });
  }
  await page.locator("#showLoot").check();

  // The inspector reads a cell's views.
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const inspected = (await snapshot()).inspector as string;
  assert.match(inspected, /^Cell \d+, \d+/);
  assert.match(inspected, /Region .*\nClass/);
  assert.match(inspected, /Proof component \d+/);

  // Its saves are the core's, byte for byte, in both encodings and as the Layout alone.
  const json = await save("#saveJson", "game.json");
  assert.equal(await readFile(json, "utf8"), chainMapToJson(reference));
  const bson = await save("#saveBson", "game.bson");
  assert.deepEqual(new Uint8Array(await readFile(bson)), chainMapToBson(reference));
  const layout = await save("#saveLayout", "game-layout.json");
  assert.equal(await readFile(layout, "utf8"), chainMapToJson(reference, { results: false }));

  // A small playground map, and the game's diagnostic beside the report.
  await page.locator("#mode").selectOption("playground");
  await page.locator("#zoneWidth").fill("3");
  await page.locator("#zoneHeight").fill("2");
  const small = await generateIn("lab-small");
  assert.deepEqual([small.params.mode, small.params.zoneWidth, small.params.zoneHeight], ["playground", 3, 2]);
  const smallReference = generate("lab-small", { mode: "playground", zoneWidth: 3, zoneHeight: 2 });
  assert.equal(small.regions, smallReference.results.length);
  await page.locator("#diagnose").click();
  await page.waitForFunction(() => (window as any).mapLab.snapshot().diagnosis, null, { timeout: 60000 });
  assert.deepEqual((await snapshot()).diagnosis.brokenPromises, checkMap(smallReference, { diagnose: true }).brokenPromises);
  assert.match(await page.locator("#diagnosticBody").innerText(), /broke their promise|No broken promises/);

  // Reading back: the Layout alone is rebuilt by the game's strategies, and BSON reads as JSON does.
  const comparable = ({ diagnosis, diagnosing, inspector, ...rest }: any) => rest;
  for (const path of [layout, bson, json]) {
    await page.locator("#load").setInputFiles(path);
    const loaded = await shown("last-exit-001");
    assert.deepEqual(comparable(loaded), comparable(first), `${path} reads back as the map it saved`);
    assert.equal(loaded.diagnosis, null, "a diagnosis belongs to the map it ran on");
    await generateIn("lab-small");
  }
  // A save from a retired version is refused by name, and the shown map stays.
  const retired = JSON.parse(await readFile(json, "utf8"));
  retired.wire = 5;
  await page.locator("#load").setInputFiles({ name: "retired.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(retired)) });
  await page.waitForFunction(() => (window as any).mapLab.snapshot().error);
  assert.match(await page.locator("#status").innerText(), /wire version 5 isn't a chain map/);
  assert.equal((await snapshot()).seed, "lab-small");

  // The diagnostic on a game map runs in a worker, so the page stays live and can cancel it.
  await page.locator("#mode").selectOption("game");
  await page.locator("#zoneWidth").fill("12");
  await page.locator("#zoneHeight").fill("6");
  await generateIn("last-exit-001");
  await page.locator("#diagnose").click();
  assert.equal((await snapshot()).diagnosing, true);
  await page.locator("#field").selectOption("proof");
  await page.locator("#cancelDiagnose").click();
  const cancelled = await snapshot();
  assert.deepEqual([cancelled.diagnosing, cancelled.diagnosis], [false, null]);
  assert.match(await page.locator("#diagnosticBody").innerText(), /Not run/);

  // The Chain Library tab (51 B1), as it was before the move.
  await page.locator("#chainTab").click();
  assert.equal(await page.locator("#chainViewContainer").isVisible(), true);
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().valid),
    true,
  );

  await page.locator("#chainSection").selectOption("classes");
  await page.locator("#chainAdd").click();
  await page.locator("#chainId").fill("checkpoint");
  await page.locator("#chainId").blur();
  await page.locator("#chainRegionType").fill("checkpoint-builder");
  await page.locator("#chainRegionType").blur();
  await page.locator('.chainCoreElements[data-kind="charger"]').fill("1");
  await page.locator('.chainCoreElements[data-kind="charger"]').blur();
  await page
    .locator('.chainCoreElements[data-kind="spawn"]')
    .fill("contestantCount");
  await page.locator('.chainCoreElements[data-kind="spawn"]').blur();

  await page.locator("#chainSection").selectOption("tiles");
  await page.locator("#chainCellBrush").selectOption("checkpoint");
  await page.locator('#chainGrid [data-cell="0,0"]').click();
  await page.locator('#chainSegments [data-segment="h:0,0"]').click();
  await page.locator("#chainSegmentAdjacency").selectOption("any");
  await page.locator("#chainSegmentPassability").selectOption("any");
  await page.locator('#chainSegments [data-segment="v:3,4"]').click();
  await page.locator("#chainSegmentPassability").selectOption("passable");
  await page.locator('#chainSegments [data-segment="v:1,1"]').click();
  await page.locator("#chainSegmentPassability").selectOption("passable");
  assert.match(
    await page.locator("#chainPreview").innerText(),
    /same region class/,
  );

  await page.locator("#chainSection").selectOption("setPieces");
  await page.locator("#chainPrimaryClass").selectOption("checkpoint");
  await page.locator("#chainSection").selectOption("setPieceClasses");
  await page.locator("#chainPlacementRule").selectOption("charger");
  await page.locator("#chainQuota").fill("2");
  await page.locator("#chainQuota").blur();
  await page
    .locator('.chainCoreElements[data-kind="charger"]')
    .fill("exitCount");
  await page.locator('.chainCoreElements[data-kind="charger"]').blur();
  await page
    .locator('.chainCoreElements[data-kind="hunter-spawn"]')
    .fill("hunterCount");
  await page.locator('.chainCoreElements[data-kind="hunter-spawn"]').blur();
  await page.locator("#chainSection").selectOption("tiles");
  await page.locator("#chainAdd").click();
  await page.locator("#chainSection").selectOption("tileSets");
  await page.locator("#chainAdd").click();
  await page
    .locator("#chainEditor label.chain-check", { hasText: "new-tile" })
    .locator("input")
    .check();
  await page.locator("#chainSection").selectOption("setPieces");
  await page.locator("#chainAdd").click();
  await page.locator("#chainPrimaryClass").selectOption("checkpoint");
  await page.locator("#chainSlotSet0").selectOption("new-set");
  await page.locator("#chainSlotOrientation0").selectOption("90");
  await page.locator("#chainSection").selectOption("setPieceClasses");
  await page.locator("#chainAdd").click();
  await page
    .locator("#chainEditor label.chain-check", { hasText: "new-piece" })
    .locator("input")
    .check();
  const chainDraft = await page.evaluate(
    () => (window as any).chainLab.snapshot().library,
  );
  assert.equal(
    chainDraft.cellClasses.checkpoint.regionType,
    "checkpoint-builder",
  );
  assert.equal(chainDraft.cellClasses.checkpoint.coreElements.charger, 1);
  assert.equal(
    chainDraft.cellClasses.checkpoint.coreElements.spawn,
    "contestantCount",
  );
  assert.equal(
    chainDraft.tiles[0].legend[chainDraft.tiles[0].cells[0][0]],
    "checkpoint",
  );
  assert.deepEqual(chainDraft.tiles[0].segments["h:0,0"], {
    adjacency: "any",
    passability: "any",
  });
  assert.equal(chainDraft.tiles[0].segments["v:3,4"].passability, "passable");
  assert.equal(chainDraft.setPieces[0].primaryRegionClass, "checkpoint");
  assert.equal(chainDraft.setPieceClasses[0].placementRule, "charger");
  assert.equal(chainDraft.setPieceClasses[0].quota, 2);
  assert.equal(chainDraft.setPieceClasses[0].coreElements.charger, "exitCount");
  assert.equal(
    chainDraft.setPieceClasses[0].coreElements["hunter-spawn"],
    "hunterCount",
  );
  assert.equal(chainDraft.tileSets[1].members.includes("new-tile"), true);
  assert.equal(chainDraft.setPieces[1].primaryRegionClass, "checkpoint");
  assert.equal(chainDraft.setPieces[1].tiles[0].tileSetId, "new-set");
  assert.equal(chainDraft.setPieces[1].tiles[0].orientation, 90);
  assert.equal(
    chainDraft.setPieceClasses[1].setPieces.includes("new-piece"),
    true,
  );
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().valid),
    true,
  );

  const chainDownload = page.waitForEvent("download");
  await page.locator("#chainExport").click();
  const exportedChain = await chainDownload;
  const chainPath = `${OUT}/chain-library.json`;
  await exportedChain.saveAs(chainPath);
  assert.deepEqual(JSON.parse(await readFile(chainPath, "utf8")), chainDraft);
  await page.locator("#chainSection").selectOption("classes");
  await page.locator("#chainAdd").click();
  await page.locator("#chainImport").setInputFiles(chainPath);
  await page.waitForFunction(
    () => !(window as any).chainLab.snapshot().library.cellClasses["new-class"],
  );
  assert.deepEqual(
    await page.evaluate(() => (window as any).chainLab.snapshot().library),
    chainDraft,
  );
  await page.locator("#chainSection").selectOption("tiles");
  await page.locator('#chainSegments [data-segment="h:0,0"]').click();
  await page.locator("#chainSegmentPassability").selectOption("");
  const unstated = await page.evaluate(
    () =>
      (window as any).chainLab.snapshot().library.tiles[0].segments["h:0,0"],
  );
  assert.deepEqual(
    unstated,
    { adjacency: "any" },
    "unstated remains distinct from written any",
  );
  await page.locator("#chainSegmentPassability").selectOption("any");
  await page.locator("#chainCellBrush").selectOption("open");
  await page.locator('#chainGrid [data-cell="3,1"]').click();
  await page.locator('#chainSegments [data-segment="v:3,0"]').click();
  await page.locator("#chainSegmentPassability").selectOption("passable");
  await page.locator('#chainSegments [data-segment="h:1,3"]').click();
  await page.locator("#chainSegmentPassability").selectOption("passable");
  assert.match(await page.locator("#chainPreview").innerText(), /right angle/);
  assert.match(
    await page.locator("#chainPreview").innerText(),
    /shorter than a hunter/,
  );
  await page.locator("#chainImport").setInputFiles([]);
  await page.locator("#chainImport").setInputFiles(chainPath);
  await page.waitForFunction(() => (window as any).chainLab.snapshot().valid);
  const invalidImport = structuredClone(chainDraft);
  invalidImport.version = -1;
  await page.locator("#chainImport").setInputFiles({
    name: "invalid-chain.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(invalidImport)),
  });
  await page.waitForFunction(() =>
    document
      .getElementById("chainStatus")
      ?.textContent?.includes("Import refused"),
  );
  assert.match(
    await page.locator("#chainStatus").innerText(),
    /Import refused/,
  );
  assert.deepEqual(
    await page.evaluate(() => (window as any).chainLab.snapshot().library),
    chainDraft,
  );
  await page.screenshot({
    path: `${OUT}/chain-authoring.png`,
    fullPage: true,
  });
  await page.locator("#chainSection").selectOption("classes");
  await page.locator("#chainItem").selectOption("open");
  await page.locator("#chainDelete").click();
  await page.locator("#chainSection").selectOption("tiles");
  await page.locator("#chainAdd").click();
  assert.equal(
    (
      await page.evaluate(() =>
        (window as any).chainLab.snapshot().library.tiles.at(-1),
      )
    ).defaultCellClass,
    "hut",
    "a new tile uses the first declared class after a class is removed",
  );
  const malformedPage = await browser.newPage();
  malformedPage.on("pageerror", (error: Error) => errors.push(error.message));
  await malformedPage.addInitScript(() =>
    localStorage.setItem(
      "last-exit-chain-library-v3",
      JSON.stringify({ version: 2 }),
    ),
  );
  await malformedPage.goto(base, { waitUntil: "domcontentloaded" });
  await malformedPage.waitForFunction(() => !!(window as any).chainLab);
  assert.match(
    await malformedPage.locator("#chainStatus").innerText(),
    /loaded the starter library/,
  );
  assert.equal(
    await malformedPage.evaluate(
      () => (window as any).chainLab.snapshot().valid,
    ),
    true,
  );
  await malformedPage.close();
  // The tab edits the chain's own library, and the World tab generates from the draft.
  await page.locator("#chainLoadBundled").click();
  assert.deepEqual(await page.evaluate(() => (window as any).chainLab.snapshot().library), CHAIN_LIBRARY);
  await page.locator("#worldTab").click();
  await page.locator("#librarySource").selectOption("draft");
  const drafted = await generateIn("from-draft");
  assert.equal(drafted.regions, generate("from-draft").results.length);
  // A draft the game can't build is refused before generating.
  await page.locator("#chainTab").click();
  await page.locator("#chainSection").selectOption("classes");
  await page.locator("#chainItem").selectOption("open");
  await page.locator("#chainRegionType").fill("no-such-strategy");
  await page.locator("#chainRegionType").blur();
  await page.locator("#worldTab").click();
  await page.locator("#generate").click();
  await page.waitForFunction(() => (window as any).mapLab.snapshot().error);
  assert.match(await page.locator("#status").innerText(), /isn't valid for the game/);

  await page.setViewportSize({ width: 560, height: 900 });
  await page.locator("#librarySource").selectOption("bundled");
  await generateIn("lab-mobile");
  await page.screenshot({ path: `${OUT}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Map Lab browser checks passed: chain maps and their views, saves equal to the core's, read-back, the diagnostic, and chain library authoring.");
} finally {
  await browser?.close();
  server.kill();
}
