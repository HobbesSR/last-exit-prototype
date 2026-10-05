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
import { mapViews } from "../../macro/src/chain/map.ts";
import { GAME_ENGINES } from "../engines.ts";

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
  assert.ok(first.portals > 0 && first.sites > 0, "portals and sites are drawn");
  // Each built part is drawn by its own layer: one shape per obstacle or gate, by kind, and a
  // roof per enclosing element, counted here from the built map itself.
  const expectedParts = { walls: 0, ruins: 0, cover: 0, windows: 0, doors: 0, roofs: 0 };
  const obstaclePart = { building: "walls", "ruin-wall": "ruins", container: "cover", crate: "cover", window: "windows" } as const;
  for (const region of mapViews(reference, GAME_ENGINES.compose).built.regions)
    for (const element of region.elements) {
      if (element.template.encloses) expectedParts.roofs++;
      for (const part of element.template.parts)
        if (part.part === "obstacle") expectedParts[obstaclePart[part.kind]]++;
        else if (part.part === "gate") expectedParts.doors++;
    }
  assert.deepEqual(first.parts, expectedParts);
  assert.ok(Object.values(expectedParts).every((n) => n > 0), "the fixed seed has every part");
  assert.equal(first.report.valid, referenceCheck.valid);
  assert.deepEqual(first.report.coreElements, referenceCheck.coreElements);
  assert.match(await page.locator("#reportBody").innerText(), /No defects found/);
  await page.screenshot({ path: `${OUT}/world.png` });

  // The layers are in chain order, with today's defaults on.
  const FIELDS = ["declared", "resolved", "regions", "proof", "zones", "bonus", "regionType", "lootChance"];
  assert.deepEqual(first.layers.map((layer: any) => layer.id),
    ["layout", "declared", "resolved", "regions", "portals", "proof", "zones", "bonus", "regionType", "lootChance", "briefs", "lots", "allocation", "spans", "openings", "graph", "walls", "ruins", "cover", "windows", "doors", "roofs", "loot", "sites", "defects", "defectSites"]);
  assert.deepEqual(first.layers.filter((layer: any) => layer.on).map((layer: any) => layer.id),
    ["regions", "portals", "lots", "allocation", "openings", "walls", "ruins", "cover", "windows", "doors", "sites", "defects", "defectSites"]);
  const ALL = first.layers.map((layer: any) => layer.id) as string[];
  assert.deepEqual(first.layers.filter((layer: any) => layer.pass === "marks").map((layer: any) => layer.id),
    ["layout", "portals", "briefs", "lots", "spans", "openings", "graph", "loot", "sites", "defectSites"], "each layer draws in one pass, the rest with the areas");
  const layer = (id: string) => page.locator(`#layer-${id}`);
  const opacity = (id: string, percent: number) => page.locator(`#layer-${id}-opacity`).fill(String(percent));
  // Every cell field alone, as the old exclusive field select showed it.
  for (const field of FIELDS) {
    for (const other of FIELDS) await layer(other).setChecked(other === field);
    await page.screenshot({ path: `${OUT}/field-${field}.png` });
  }

  // The macro layers (#201), each alone, with legends read from the same views.
  const referenceViews = mapViews(reference, GAME_ENGINES.compose);
  const legend = (id: string) => page.locator(`#legend-${id} span`).allInnerTexts();
  const sorted = (names: Iterable<string>) => [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const MACRO: Record<string, string[]> = {
    layout: ["tile", ...sorted(reference.layout.setPieces.map((piece) => `set piece, ${piece.setPieceClass}`))],
    bonus: sorted(referenceViews.zones.map((zone) => `bonus ${zone.bonus}`)),
    regionType: sorted(referenceViews.briefs.map((brief) => brief.type)),
    lootChance: sorted(referenceViews.briefs.flatMap((brief) => brief.zones.map((zone) => `${Math.round(zone.lootChance * 100)}% loot`))),
    briefs: ["core elements assigned", "portal, as its region's brief states it"],
  };
  for (const id of ALL) await layer(id).uncheck();
  for (const [id, expected] of Object.entries(MACRO)) {
    assert.deepEqual(await legend(id), [], `${id} shows no legend while off`);
    await layer(id).check();
    assert.deepEqual(sorted(await legend(id)), sorted(expected), `${id}'s legend`);
    assert.ok(expected.length > 1 || id === "bonus", `the fixed seed gives ${id} more than one value`);
    await page.screenshot({ path: `${OUT}/macro-${id}.png` });
    await layer(id).uncheck();
  }
  // Zoomed in, the layout and briefs label tiles, set pieces, portals and assignments.
  await layer("regionType").check();
  await layer("layout").check();
  await layer("briefs").check();
  for (let i = 0; i < 9; i++) await page.locator("#zoomIn").click();
  await page.screenshot({ path: `${OUT}/macro-zoomed.png` });
  await page.locator("#zoomReset").click();

  // One layer under another: the canvas centre's pixel, with only cell fields drawn.
  const centre = () => page.evaluate(() => {
    const map = document.getElementById("map") as HTMLCanvasElement;
    return [...map.getContext("2d")!.getImageData(map.width >> 1, map.height >> 1, 1, 1).data];
  });
  for (const id of ALL) await layer(id).setChecked(id === "regions");
  const regionsAlone = await centre();
  assert.equal(regionsAlone[3], 255, "the centre lies in a region");
  await layer("declared").check();
  assert.deepEqual(await centre(), regionsAlone, "an opaque later layer hides the one under it");
  await opacity("regions", 50);
  assert.equal((await snapshot()).layers.find((l: any) => l.id === "regions").opacity, 0.5, "the slider sets the layer's opacity");
  const overDeclared = await centre();
  assert.notDeepEqual(overDeclared, regionsAlone, "a half-opaque layer shows the one under it");
  await layer("declared").uncheck();
  const overNothing = await centre();
  assert.notDeepEqual(overNothing, overDeclared, "turning the lower layer off changes what shows through");
  assert.ok(overNothing[3]! < 255, "with nothing under it, the half-opaque layer is see-through");
  await page.screenshot({ path: `${OUT}/stacked.png` });
  await opacity("regions", 100);

  // A layer's opacity is uniform: each is laid on once, so where its own parts overlap (a
  // site's fill and outline, boundaries and portals, sites on each other) nothing alone at
  // 50% is more than half opaque.
  const alpha = () => page.evaluate(() => {
    const map = document.getElementById("map") as HTMLCanvasElement;
    const { data } = map.getContext("2d")!.getImageData(0, 0, map.width, map.height);
    let most = 0;
    for (let i = 3; i < data.length; i += 4) most = Math.max(most, data[i]!);
    return most;
  });
  for (const id of ALL) await layer(id).uncheck();
  for (const id of ALL) {
    await layer(id).check();
    await opacity(id, 100);
    const full = await alpha();
    await opacity(id, 50);
    const half = await alpha();
    assert.ok(half <= Math.ceil(full / 2) + 2, `${id} at 50% is at most half as opaque as at 100%: ${half} vs ${full}`);
    await opacity(id, first.layers.find((l: any) => l.id === id).opacity * 100);
    await layer(id).uncheck();
  }
  for (const id of ALL) await layer(id).setChecked(first.layers.find((l: any) => l.id === id).on);
  await layer("loot").check();

  // Zoom buttons, and Reset back to the fitted 100%.
  await page.locator("#zoomIn").click();
  assert.equal((await snapshot()).zoom, "125%");
  await page.locator("#zoomReset").click();
  assert.equal((await snapshot()).zoom, "100%");

  // The inspector reads a cell's views.
  const box = (await page.locator("#map").boundingBox())!;
  // Hovering shows the inspector's first lines.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await page.locator("#tooltip").isVisible(), true);
  assert.match(await page.locator("#tooltip").innerText(), /^Cell \d+, \d+\nTile \S+ at \d+°.*\nDeclared/);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const inspected = (await snapshot()).inspector as string;
  assert.match(inspected, /^Cell \d+, \d+/);
  assert.match(inspected, /Region .*\nClass/);
  assert.match(inspected, /Proof component \d+/);
  assert.match(inspected, /\nTile \S+ at \d+°/);
  assert.match(inspected, /Brief: type \S+, \d+ portals.*\nAssigned core elements: .+\n(Parameters: .*\n)?Loot chance \d+%/);
  assert.match((await page.locator("#inspectorLinks button").allInnerTexts())[0]!, /^Edit tile design \S+$/);
  assert.match(inspected, /Parts: \d+ walls, \d+ ruins, \d+ cover, \d+ windows, \d+ doors, \d+ roofs\nElements: /);

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
  const comparable = ({ diagnosis, diagnosing, inspector, zoom, layers, ...rest }: any) => rest;
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

  // A larger authored size, picked from the size menu, takes its own library (#171).
  await page.locator("#mode").selectOption("game");
  await page.locator("#zoneSize").selectOption("24x12");
  const large = await generateIn("lab-large");
  assert.deepEqual([large.params.zoneWidth, large.params.zoneHeight], [24, 12]);
  assert.equal(large.regions, generate("lab-large", { zoneWidth: 24, zoneHeight: 12 }).results.length);

  // The diagnostic on a game map runs in a worker, so the page stays live and can cancel it.
  await page.locator("#zoneWidth").fill("12");
  await page.locator("#zoneHeight").fill("6");
  await generateIn("last-exit-001");
  await page.locator("#diagnose").click();
  assert.equal((await snapshot()).diagnosing, true);
  await page.locator("#layer-proof").check();
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

  // Drilling into a region rebuilds it in the worker with an observer (53 "Region drill-down").
  // A hut on the default seed shows its house; a block on last-exit-009 its lots, and the
  // compound one of them holds. Each rebuild equals the stored result, so its traces are drawn.
  const drillPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  drillPage.on("pageerror", (error: Error) => errors.push(error.message));
  await drillPage.goto(base, { waitUntil: "domcontentloaded" });
  const drillSnapshot = () => drillPage.evaluate(() => (window as any).mapLab.snapshot());
  const drillShown = (seed: string) => drillPage.waitForFunction((s: string) => {
    const lab = (window as any).mapLab?.snapshot();
    return lab && !lab.busy && lab.seed === s;
  }, seed, { timeout: 60000 });
  const drillInto = async (brief: { id: string; cells: Array<{ x: number; y: number }> }) => {
    const cell = brief.cells[Math.floor(brief.cells.length / 2)]!;
    await drillPage.evaluate(([x, y]: number[]) => (window as any).mapLab.select(x, y), [cell.x, cell.y]);
    await drillPage.waitForFunction((id: string) => {
      const drill = (window as any).mapLab.snapshot().drill;
      return drill?.id === id && !drill.pending && drill.fragment;
    }, brief.id, { timeout: 30000 });
    return drillSnapshot();
  };
  await drillShown("last-exit-001");
  const hutBrief = mapViews(reference).briefs.find((brief) => brief.type === "hut")!;
  for (const id of ["allocation", "spans", "openings", "graph"]) await drillPage.locator(`#layer-${id}`).check();
  const hutDrill = await drillInto(hutBrief);
  assert.equal(hutDrill.drill.difference, null, "the hut rebuilds equal to the stored result");
  assert.deepEqual(hutDrill.drill.buildings, ["hut-building"]);
  assert.ok(hutDrill.drill.drawn.allocation.cells > 0 && hutDrill.drill.drawn.openings.openings > 0, "the hut's allocation and openings are drawn");
  assert.ok(hutDrill.drill.drawn.graph.nodes > 0 && hutDrill.drill.drawn.spans.spans > 0, "the hut's design graph and spans are drawn");
  assert.match(hutDrill.inspector, /Drill-down: rebuilt equal to the stored result; 1 building from designs/);
  assert.match(hutDrill.inspector, /hut-building: \d+ spaces?, \d+ connections/);
  assert.ok(hutDrill.links.some((link: { label: string }) => link.label === "Save this region's brief"));
  await drillPage.screenshot({ path: `${OUT}/drill-hut.png` });
  // A cell outside every region drills nothing.
  await drillPage.evaluate(() => (window as any).mapLab.select(0, 0));
  assert.equal((await drillSnapshot()).drill, null);

  await drillPage.locator("#seed").fill("last-exit-009");
  await drillPage.locator("#generate").click();
  await drillShown("last-exit-009");
  const blockBrief = mapViews(generate("last-exit-009")).briefs.find((brief) => brief.type === "block")!;
  const blockDrill = await drillInto(blockBrief);
  assert.equal(blockDrill.drill.difference, null, "the block rebuilds equal to the stored result");
  assert.deepEqual(blockDrill.drill.lots.map((lot: { type: string }) => lot.type), ["depot", "compound", "cover"]);
  assert.deepEqual(blockDrill.drill.buildings, ["lot-2/compound"], "the compound lot's ring is traced, labelled as the lot's element");
  assert.equal(blockDrill.drill.drawn.lots.lots, 3);
  assert.ok(blockDrill.drill.drawn.graph.nodes > 0);
  assert.match(blockDrill.inspector, /3 lots/);
  await drillPage.screenshot({ path: `${OUT}/drill-block.png` });
  await drillPage.close();

  // The inspector opens a cell's tile design in the Chain Library tab. A fresh page's draft is
  // the starter library, so it asks before replacing the draft with the map's.
  const linkPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  linkPage.on("pageerror", (error: Error) => errors.push(error.message));
  const asked: string[] = [];
  linkPage.on("dialog", (dialog: any) => (asked.push(dialog.message()), dialog.accept()));
  await linkPage.goto(base, { waitUntil: "domcontentloaded" });
  await linkPage.waitForFunction(() => (window as any).mapLab?.snapshot().seed === "last-exit-001" && !(window as any).mapLab.snapshot().busy, null, { timeout: 60000 });
  const linkBox = (await linkPage.locator("#map").boundingBox())!;
  await linkPage.mouse.click(linkBox.x + linkBox.width / 2, linkBox.y + linkBox.height / 2);
  const design = /^Edit tile design (\S+)$/.exec(await linkPage.locator("#inspectorLinks button").first().innerText())![1]!;
  await linkPage.locator("#inspectorLinks button").first().click();
  assert.equal(await linkPage.locator("#chainViewContainer").isVisible(), true);
  const opened = await linkPage.evaluate(() => (window as any).chainLab.snapshot());
  assert.deepEqual([opened.section, opened.selectedId], ["tiles", design]);
  assert.deepEqual(opened.library, CHAIN_LIBRARY, "the draft is now the map's library");
  assert.equal(asked.length, 1, "replacing the draft was asked first");
  await linkPage.close();

  await page.setViewportSize({ width: 560, height: 900 });
  await page.locator("#librarySource").selectOption("bundled");
  await generateIn("lab-mobile");
  await page.screenshot({ path: `${OUT}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Map Lab browser checks passed: chain maps and their layers, saves equal to the core's, read-back, the diagnostic, and chain library authoring.");
} finally {
  await browser?.close();
  server.kill();
}
