/**
 * The Map Lab in a browser (53, "Tools"). It generates chain maps through the tools' core,
 * so its saves must equal the core's own for the same seed, and a save it reads back must
 * show the same map. Run from the repository root: `node map/tools/tests/lab.browser.mts`.
 */
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { CHAIN_LIBRARY, chainParams, checkMap, generate } from "../core.ts";
import { libraryFingerprint } from "../../macro/src/coding.ts";
import { planBlock } from "../../micro/strategies/block.ts";
import { chainMapToBson, chainMapToJson } from "../../macro/src/chain/saving.ts";
import { mapViews } from "../../macro/src/chain/map.ts";
import { DEFAULT_CELL_SIZE, GAME_ENGINES } from "../engines.ts";
import { measureRoutes } from "../routes.ts";
import { liveChainParams } from "../../live.ts";
import { PLACEABLES } from "../../micro/placeables/index.ts";
// @ts-expect-error The game server is JavaScript without declarations.
import { createArenaServer } from "../../../server/index.js";
// @ts-expect-error The test helpers are JavaScript without declarations.
import { listen } from "../../../tests/helpers/listen.js";

const require = createRequire(import.meta.url);
let playwright: any;
try {
  playwright = require("@playwright/test");
} catch {
  throw Error("The Map Lab's browser check needs @playwright/test; run npm ci at the repository root.");
}
const OUT = "test-results/map-lab";
await mkdir(OUT, { recursive: true });
// The game's server, which the lab links to as its peer (20.5) for "Play in the game".
const replayDir = await mkdtemp(path.join(tmpdir(), "map-lab-browser-"));
const game = await createArenaServer({ replayDir, profileSummary: false, devTools: 'all' });
const gameUrl: string = await listen(game);
// A room's player waits in the yard (#236) until its owner starts the match, so the first map a
// room shows is the yard's. The linked room is the page's own, so it starts the match and waits
// for the map it was asked for.
async function matchMap(room: any, seed: number, timeout: number) {
  await room.getByRole("button", { name: "Start match", exact: true }).click({ timeout });
  await room.waitForFunction((seed: number) => (window as any).arenaDebug?.().map?.seed === seed, seed, { timeout });
  return room.evaluate(() => (window as any).arenaDebug().map);
}
// The Map Lab now runs on the game server itself.
const base = gameUrl + '/dev/map';
let browser: any;
try {
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
  const openActionMenu = async (tab: any, control: string) => {
    const menu = tab.locator(`#worldActions details:has(#${control})`);
    if (!await menu.evaluate((details: HTMLDetailsElement) => details.open)) await menu.locator("summary").click();
  };
  const save = async (button: string, name: string) => {
    await openActionMenu(page, "saveJson");
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
  const expectedParts = { walls: 0, ruins: 0, cover: 0, windows: 0, pipes: 0, doors: 0, roofs: 0 };
  const obstaclePart = { building: "walls", "ruin-wall": "ruins", container: "cover", crate: "cover", tree: "cover", hedge: "cover", window: "windows", pipe: "pipes" } as const;
  for (const region of mapViews(reference, GAME_ENGINES.compose).built.regions)
    for (const element of region.elements) {
      if (element.template.encloses) expectedParts.roofs++;
      for (const part of element.template.parts)
        if (part.part === "obstacle") expectedParts[obstaclePart[part.kind]]++;
        else if (part.part === "gate") expectedParts.doors++;
    }
  assert.deepEqual(first.parts, expectedParts);
  assert.ok(Object.entries(expectedParts).filter(([kind]) => kind !== "pipes").every(([, n]) => n > 0),
    "the fixed seed covers the other built parts; pipes have an explicit rendering fixture below");
  assert.equal(first.report.valid, referenceCheck.valid);
  assert.deepEqual(first.report.coreElements, referenceCheck.coreElements);
  assert.match(await page.locator("#reportBody").innerText(), /No defects found/);
  await page.screenshot({ path: `${OUT}/world.png` });

  // The World workspace keeps its map, actions and inspector usable at desktop sizes.
  // A click at the fitted canvas centre must still address the same cell after resize.
  const workspaceGeometry = () => page.evaluate(() => {
    const rect = (selector: string) => {
      const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
      return { x, y, width, height, right: x + width, bottom: y + height };
    };
    return {
      sidebar: rect("#sidebar"), main: rect(".world-main"), map: rect("#map"),
      inspector: rect("#worldInspector"), actions: rect("#worldActions"),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  const checkWorkspace = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await page.locator("#zoomReset").click();
    const g = await workspaceGeometry();
    assert.ok(g.sidebar.right <= g.map.x + 1, `${width}: recipe/layers stay left of the map`);
    assert.ok(g.map.right <= g.inspector.x + 1, `${width}: inspector stays right of the map`);
    assert.ok(g.actions.bottom <= g.map.y + 1, `${width}: actions sit above the map`);
    assert.ok(g.map.width >= 300 && g.map.height >= 200, `${width}: map has useful visible area`);
    assert.ok(g.map.x >= 0 && g.map.right <= width + 1 && g.map.y >= 0 && g.map.bottom <= height + 1,
      `${width}: canvas fits in the viewport`);
    assert.equal(await page.locator("#sidebar #generate").isVisible(), true, `${width}: generate is available in the recipe`);
    assert.equal(await page.locator("#worldActions details").count(), 2, `${width}: save/load and play have action menus`);
    await openActionMenu(page, "saveJson");
    for (const id of ["saveJson", "saveBson", "saveLayout", "load"])
      assert.equal(await page.locator(`#worldActions #${id}`).count(), 1, `${width}: ${id} stays in the save/load menu`);
    assert.equal(await page.locator("#worldActions #saveJson").isVisible(), true);
    await openActionMenu(page, "roomRecipe");
    assert.equal(await page.locator("#worldActions #roomRecipe").isVisible(), true, `${width}: play controls are reachable`);
    await page.locator("#worldActions details:has(#roomRecipe) summary").click();
    assert.equal(await page.locator("#zoomReset").innerText(), "Fit");
    const mapBox = (await page.locator("#map").boundingBox())!;
    const target = { x: Math.floor(first.grid.width / 2), y: Math.floor(first.grid.height / 2) };
    const fittedZoom = Math.min(mapBox.width / first.grid.width, mapBox.height / first.grid.height) * 0.96;
    await page.mouse.click(
      mapBox.x + (mapBox.width - first.grid.width * fittedZoom) / 2 + (target.x + 0.5) * fittedZoom,
      mapBox.y + (mapBox.height - first.grid.height * fittedZoom) / 2 + (target.y + 0.5) * fittedZoom,
    );
    const selected = (await snapshot()).selected;
    assert.deepEqual(selected, target, `${width}: a fitted canvas click selects the same cell after resize`);
    await page.screenshot({ path: `${OUT}/workspace-${width}x${height}.png` });
    return g;
  };
  const desktop = await checkWorkspace(1440, 900);
  await openActionMenu(page, "saveJson");
  await page.screenshot({ path: `${OUT}/workspace-save-menu.png` });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#worldActions details:has(#saveJson)").evaluate((d: HTMLDetailsElement) => d.open), false,
    "Escape closes the save/load menu");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Save / load",
    "Escape returns focus to the save/load summary");
  await openActionMenu(page, "roomRecipe");
  await page.screenshot({ path: `${OUT}/workspace-play-menu.png` });
  const outsideBox = (await page.locator("#map").boundingBox())!;
  await page.mouse.click(outsideBox.x + outsideBox.width / 2, outsideBox.y + outsideBox.height / 2);
  assert.equal(await page.locator("#worldActions details:has(#roomRecipe)").evaluate((d: HTMLDetailsElement) => d.open), false,
    "a canvas click dismisses the play menu");
  await page.locator("#sidebar").evaluate((sidebar: HTMLElement) => { sidebar.scrollTop = sidebar.scrollHeight; });
  const scrolled = await workspaceGeometry();
  assert.ok(await page.locator("#sidebar").evaluate((sidebar: HTMLElement) => sidebar.scrollTop) > 0,
    "the layers sidebar has independent scrolling");
  assert.deepEqual(scrolled.map, desktop.map, "scrolling the recipe/layers sidebar leaves the canvas fixed");
  await page.locator("#sidebar").evaluate((sidebar: HTMLElement) => { sidebar.scrollTop = 0; });
  await checkWorkspace(1280, 720);
  await page.setViewportSize({ width: 760, height: 900 });
  for (const id of ["seed", "generate", "layer-regions", "zoomReset", "inspector"])
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
  await openActionMenu(page, "saveJson");
  await page.locator("#saveJson").scrollIntoViewIfNeeded();
  await openActionMenu(page, "roomRecipe");
  await page.locator("#roomRecipe").scrollIntoViewIfNeeded();
  assert.ok(await page.locator("#map").boundingBox(), "the narrow workspace still exposes its canvas");
  await page.screenshot({ path: `${OUT}/workspace-760x900.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#zoomReset").click();
  await generateIn("last-exit-001");
  assert.equal((await snapshot()).selected, null, "workspace checks leave no selection over the layer pixels");

  // The layers are in chain order, with today's defaults on.
  const FIELDS = ["declared", "resolved", "regions", "proof", "zones", "bonus", "regionType", "lootChance"];
  assert.deepEqual(first.layers.map((layer: any) => layer.id),
    ["layout", "declared", "resolved", "regions", "portals", "proof", "zones", "bonus", "regionType", "lootChance", "reducedFill", "internalGuaranteed", "briefs", "lots", "allocation", "spans", "openings", "graph", "walls", "ruins", "cover", "windows", "pipes", "doors", "roofs", "loot", "sites", "routes", "defects", "defectSites"]);
  assert.deepEqual(first.layers.filter((layer: any) => layer.on).map((layer: any) => layer.id),
    ["regions", "portals", "lots", "allocation", "openings", "walls", "ruins", "cover", "windows", "pipes", "doors", "sites", "routes", "defects", "defectSites"]);
  const ALL = first.layers.map((layer: any) => layer.id) as string[];
  assert.deepEqual(first.layers.filter((layer: any) => layer.pass === "marks").map((layer: any) => layer.id),
    ["layout", "portals", "internalGuaranteed", "briefs", "lots", "spans", "openings", "graph", "loot", "sites", "routes", "defectSites"], "each layer draws in one pass, the rest with the areas");
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
  assert.match(inspected, /Brief: type \S+, \d+ portals.*\nAssigned core elements: .+\nReduced fill: .*\nInternal guaranteed runs: \d+\n(Parameters: .*\n)?Loot chance \d+%/);
  assert.match((await page.locator("#inspectorLinks button").allInnerTexts())[0]!, /^Edit tile design \S+$/);
  assert.match(inspected, /Parts: \d+ walls, \d+ ruins, \d+ cover, \d+ windows, \d+ pipes, \d+ doors, \d+ roofs\nElements: /);

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
  // Pipe rendering should not depend on a seeded factory retaining a large unbroken fill.
  // The margin policy can split that fill. Arrange a contained pipe in a stored result,
  // and require both the exact part count and visible output from its own layer.
  const pipeFixture = structuredClone(reference);
  const pipeOwner = pipeFixture.results.find(region => region.brief.fillCells?.length)!;
  const pipeCell = pipeOwner.brief.fillCells![0]!;
  pipeOwner.elements.push({ label: "browser-pipe", x: pipeCell.x * pipeFixture.cellSize, y: pipeCell.y * pipeFixture.cellSize,
    template: { w: pipeFixture.cellSize, h: pipeFixture.cellSize, parts: [{ part: "obstacle", kind: "pipe",
      shape: { kind: "rect", x: 4, y: 16, w: 32, h: 8 } }] } });
  pipeOwner.manifest.obstacles = (pipeOwner.manifest.obstacles ?? 0) + 1;
  await page.locator("#load").setInputFiles({ name: "pipe-rendering.json", mimeType: "application/json",
    buffer: Buffer.from(chainMapToJson(pipeFixture)) });
  const pipeShown = await shown("last-exit-001");
  assert.deepEqual(pipeShown.parts, { ...expectedParts, pipes: expectedParts.pipes + 1 });
  assert.ok(Object.values(pipeShown.parts as Record<string, number>).every(n => n > 0), "all built part kinds have browser coverage");
  for (const id of ALL) await layer(id).setChecked(id === "pipes");
  assert.ok(await alpha() > 0, "the pipe layer paints the fixture collider");
  for (const id of ALL) await layer(id).setChecked(first.layers.find((l: any) => l.id === id).on);
  await generateIn("lab-small");
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
  const largeMap = generate("lab-large", { zoneWidth: 24, zoneHeight: 12 });
  assert.deepEqual([large.params.zoneWidth, large.params.zoneHeight], [24, 12]);
  assert.equal(large.regions, largeMap.results.length);

  // A compound that delegates its exterior cover rebuilds its ring plus that cover in
  // the Map Lab worker, rather than losing child geometry during drill-down. It is found
  // by that condition, not by id, so a content change that moves regions can't hide it.
  const adoptionRegion = largeMap.results.find(region =>
    region.brief.id.startsWith("compound@") && region.elements.some(element => element.label.includes("/delegate/")));
  assert.ok(adoptionRegion, "lab-large has a compound that delegates its exterior cover");
  const adoptionCell = adoptionRegion.brief.cells[0]!;
  await page.evaluate(([x, y]: number[]) => (window as any).mapLab.select(x, y), [adoptionCell.x, adoptionCell.y]);
  await page.waitForFunction((id: string) => {
    const drill = (window as any).mapLab.snapshot().drill;
    return drill?.id === id && !drill.pending && drill.fragment;
  }, adoptionRegion.brief.id, { timeout: 30000 });
  const adoptionDrill = await snapshot();
  assert.equal(adoptionDrill.drill.difference, null, "compound ring and delegated cover rebuild equal to stored output");
  assert.deepEqual(adoptionDrill.drill.buildings, ["compound"]);
  await page.screenshot({ path: `${OUT}/compound-delegation.png`, fullPage: true });

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
  assert.equal(await page.locator("#chainSurface #chainId").count(), 1, "non-visual entry identity belongs to its central property form");
  assert.equal(await page.locator("#chainSurface #chainRegionType").count(), 1);
  assert.equal(await page.locator("#chainProperties input").count(), 0, "class fields are not split across panes");
  await page.screenshot({ path: `${OUT}/class-properties.png` });
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
  await page.locator('#chainSegments [data-segment="v:0,1"]').click();
  assert.equal(
    await page.locator('#chainSegmentPassability option[value="not-passable-hint"]').textContent(),
    "Prefer occupied (hint)",
  );
  assert.match(await page.locator("#chainEditor").innerText(), /never an impassability requirement/);
  await page.locator("#chainSegmentPassability").selectOption("not-passable-hint");
  await page.locator('#chainSegments [data-segment="v:1,1"]').click();
  await page.locator("#chainSegmentPassability").selectOption("passable");
  assert.match(
    await page.locator("#chainPreview").innerText(),
    /same region class/,
  );

  await page.locator("#chainSection").selectOption("setPieces");
  await page.locator("#chainPrimaryClass").selectOption("checkpoint");
  await page.locator("#chainSection").selectOption("setPieceClasses");
  assert.equal(await page.locator("#chainSurface #chainId").count(), 1);
  assert.equal(await page.locator("#chainSurface #chainPlacementRule").count(), 1);
  assert.equal(await page.locator("#chainSurface #chainQuota").count(), 1, "set-piece class properties share one form");
  await page.screenshot({ path: `${OUT}/set-piece-class-properties.png` });
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
    .locator('#setAvailableGallery .tile-card[data-tile="new-tile"]')
    .click();
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
  assert.equal(chainDraft.tiles[0].segments["v:0,1"].passability, "not-passable-hint");
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
  await page.locator('#chainSegments [data-segment="v:0,1"]').click();
  assert.equal(await page.locator("#chainSegmentPassability").inputValue(), "not-passable-hint");
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

  // Interactive tile stage tests (#303): swatches, gutters, eyedropper, patterns, and clear
  await page.locator("#chainSection").selectOption("tiles");
  await page.locator('.chain-swatch-button[data-class="arrival"]').click();
  assert.equal(await page.locator("#chainCellBrush").inputValue(), "arrival");
  // Column gutter click paints column 0 with arrival
  await page.locator(".chain-gutter.cols button").first().click();
  let stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  const arrivalMark = Object.entries(stageTile.legend ?? {}).find(
    ([, v]) => v === "arrival",
  )?.[0];
  assert.ok(arrivalMark, "arrival is recorded in the legend");
  assert.equal(stageTile.cells[0][0], arrivalMark);
  assert.equal(stageTile.cells[5][0], arrivalMark);

  // Eyedropper Alt-click on cell (5, 5) which is "hut"
  await page
    .locator('#chainGrid [data-cell="5,5"]')
    .click({ modifiers: ["Alt"] });
  assert.equal(await page.locator("#chainCellBrush").inputValue(), "hut");

  // Pattern tool (Perimeter)
  await page
    .locator(".chain-tool-group button", { hasText: "Perimeter" })
    .click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  const hutMark = Object.entries(stageTile.legend ?? {}).find(
    ([, v]) => v === "hut",
  )?.[0];
  assert.equal(stageTile.cells[0][5], hutMark);

  // Clear painting resets cells and legend
  await page
    .locator(".chain-tool-group button", { hasText: "Clear painting" })
    .click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(stageTile.cells, undefined, "clearing painting removes cells");
  assert.equal(stageTile.legend, undefined, "clearing painting removes legend");

  // #515: the catalogue and properties scroll beside the selected object's work surface.
  for (const width of [1440, 1180]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#chainEditor .chain-inspector").evaluate((node: HTMLElement) => { node.scrollTop = 0; });
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return { x: r.x, right: r.right, y: r.y, bottom: r.bottom };
      };
      return { catalogue: rect("#chainViewContainer .chain-sidebar"), surface: rect("#chainSurface"), properties: rect("#chainEditor .chain-inspector") };
    });
    assert.ok(boxes.catalogue.right <= boxes.surface.x && boxes.surface.right <= boxes.properties.x, `${width}: catalogue, surface and properties are side by side`);
    assert.ok(boxes.properties.right <= width && boxes.surface.bottom <= 900, "workspace stays inside the desktop viewport");
    assert.equal(await page.locator("#chainSelected").innerText(), await page.locator("#chainItem").inputValue());
    await page.locator('.chain-swatch-button[data-class="arrival"]').click();
    const gridBox = await page.locator("#chainGrid").boundingBox();
    assert.ok(gridBox.y >= boxes.surface.y && gridBox.y + gridBox.height <= boxes.surface.bottom, `${width}: the entire tile grid is visible beside the toolbar`);
    await page.mouse.click(gridBox.x + gridBox.width * 2.5 / 6, gridBox.y + gridBox.height * 3.5 / 6);
    const tile = await page.evaluate(() => (window as any).chainLab.snapshot().library.tiles[0]);
    assert.equal(tile.legend[tile.cells[3][2]], "arrival", `${width}: resized stage paints logical cell (2,3)`);
    await page.screenshot({ path: `${OUT}/authoring-${width}.png` });
    await page.locator('.chain-tool-group button', { hasText: "Clear painting" }).click();
  }
  const authoringBefore = await page.evaluate(() => (window as any).chainLab.snapshot());
  await page.locator("#worldTab").click();
  await page.locator("#chainTab").click();
  assert.deepEqual(await page.evaluate(() => (window as any).chainLab.snapshot()), authoringBefore, "changing tabs preserves selected entry and draft");
  const surfaceBeforeScroll = await page.locator("#chainSurface").boundingBox();
  await page.locator("#chainEditor .chain-inspector").evaluate((node: HTMLElement) => { node.scrollTop = node.scrollHeight; });
  assert.ok(await page.locator("#chainEditor .chain-inspector").evaluate((node: HTMLElement) => node.scrollTop > 0), "properties have their own scroll area");
  assert.deepEqual(await page.locator("#chainSurface").boundingBox(), surfaceBeforeScroll, "scrolling properties keeps the stage in place");
  await page.locator("#chainEditor .chain-inspector").evaluate((node: HTMLElement) => { node.scrollTop = 0; });
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Context menus fit beside pane edges and disappear when the workspace scrolls.
  await page.setViewportSize({ width: 1180, height: 900 });
  const assertPopupFits = async () => {
    const box = await page.locator(".chain-popup").boundingBox();
    assert.ok(box && box.x >= 8 && box.y >= 8 && box.x + box.width <= 1172 && box.y + box.height <= 892, "entire context menu fits in the viewport");
  };
  await page.locator('#chainGrid [data-cell="5,5"]').click({ button: "right" });
  await assertPopupFits();
  await page.screenshot({ path: `${OUT}/cell-menu-fitted.png` });
  await page.locator("#chainSurface").evaluate((node: HTMLElement) => {
    node.scrollTop = node.scrollTop > 0 ? 0 : node.scrollHeight;
  });
  await page.waitForFunction(() => !document.querySelector(".chain-popup"));
  await page.locator('.chain-tool-group button[data-tool="segment"]').click();
  await page.locator('[data-stage-segment="h:6,5"]').click({ button: "right" });
  await assertPopupFits();
  await page.screenshot({ path: `${OUT}/segment-menu-fitted.png` });
  await page.locator("#chainEditor .chain-inspector").evaluate((node: HTMLElement) => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => !document.querySelector(".chain-popup"));
  await page.locator('.chain-tool-group button[data-tool="paint"]').click();
  await page.setViewportSize({ width: 1440, height: 1000 });

  // #539: non-tile sections are browsed in a scrollable entry list; tiles keep their gallery.
  const entryBefore = await page.evaluate(() => (window as any).chainLab.snapshot());
  const listed = () => page.locator("#chainEntryList button").evaluateAll((rows: HTMLElement[]) => rows.map((row) => row.dataset.entry));
  const active = () => page.locator("#chainEntryList button.active").getAttribute("data-entry");
  const applySource = async (library: unknown) => {
    await page.locator("#chainSource").evaluate((node: HTMLElement) => { (node.closest("details") as HTMLDetailsElement).open = true; });
    await page.locator("#chainSource").fill(JSON.stringify(library));
    await page.locator("#chainApply").click();
    await page.locator("#chainSource").evaluate((node: HTMLElement) => { (node.closest("details") as HTMLDetailsElement).open = false; });
  };
  for (const kind of ["classes", "tileSets", "setPieces", "setPieceClasses"]) {
    await page.locator("#chainSection").selectOption(kind);
    assert.equal(await page.locator("#chainEntryList").isVisible(), true, `${kind}: entries are listed`);
    assert.equal(await page.locator("#chainItem").isVisible(), false, `${kind}: the list replaces the entry dropdown`);
    const ids = await page.evaluate(() => {
      const { library, section } = (window as any).chainLab.snapshot();
      return section === "classes" ? Object.keys(library.cellClasses) : library[section].map((e: any) => e.id);
    });
    assert.deepEqual(await listed(), ids, `${kind}: every entry is listed in library order`);
    assert.equal(await active(), await page.locator("#chainSelected").innerText(), `${kind}: the active entry is marked`);
    assert.equal(await page.locator("#chainEntryList button[aria-selected=true]").count(), 1);
    assert.equal(await page.locator("#chainEntryList button[role=option]").count(), ids.length, `${kind}: rows are listbox options`);
  }
  await page.locator("#chainSection").selectOption("tiles");
  assert.equal(await page.locator("#chainEntryList").isVisible(), false, "tiles are browsed by thumbnail");
  assert.equal(await page.locator("#chainItem").isVisible(), true);

  await page.locator("#chainSection").selectOption("classes");
  await page.locator("#chainAdd").click();
  assert.equal(await active(), "new-class", "an added entry is listed and active");
  await page.locator("#chainClone").click();
  const cloned = await page.evaluate(() => (window as any).chainLab.snapshot().selectedId);
  assert.equal(await active(), cloned, "a duplicate is listed and active");
  await page.locator("#chainId").fill("renamed-class");
  await page.locator("#chainId").blur();
  assert.equal(await active(), "renamed-class", "a rename updates its row");
  assert.equal((await listed()).includes(cloned), false);
  await page.locator('#chainEntryList button[data-entry="new-class"]').click();
  assert.equal(await page.locator("#chainSelected").innerText(), "new-class", "clicking a row selects it");
  await page.locator("#chainDelete").click();
  assert.equal((await listed()).includes("new-class"), false, "a deleted entry leaves the list");
  assert.equal(await active(), await page.locator("#chainSelected").innerText());

  // Keyboard: the active row is the list's tab stop and arrow keys move the selection.
  await page.locator("#chainEntryList button.active").focus();
  const names = await listed();
  await page.keyboard.press("Home");
  assert.equal(await active(), names[0]);
  await page.keyboard.press("ArrowDown");
  assert.equal(await active(), names[1], "ArrowDown selects the next entry");
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.entry), names[1], "focus follows the selection");
  await page.keyboard.press("ArrowUp");
  assert.equal(await active(), names[0]);
  // At an end the selection and its editor stay as they were.
  await page.locator("#chainId").evaluate((node: HTMLElement) => { node.dataset.kept = "yes"; });
  await page.locator("#chainEntryList button.active").focus();
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.locator("#chainId").getAttribute("data-kept"), "yes", "a keypress that can't move doesn't rebuild the workspace");
  assert.equal(await page.locator("#chainEntryList button[tabindex='0']").count(), 1);

  // A long imported catalogue scrolls inside the list; an empty section says so.
  const long = structuredClone(entryBefore.library);
  for (let i = 0; i < 80; i++) long.cellClasses[`bulk-${String(i).padStart(2, "0")}`] = { regionType: `bulk-${i}` };
  long.setPieceClasses = [];
  await applySource(long);
  assert.equal(await active(), Object.keys(long.cellClasses)[0], "an import selects the first entry");
  assert.equal((await listed()).length, Object.keys(long.cellClasses).length);
  const surfaceBeforeList = await page.locator("#chainSurface").boundingBox();
  await page.locator("#chainEntryList button.active").focus();
  await page.keyboard.press("End");
  assert.equal(await active(), "bulk-79");
  const fits = await page.evaluate(() => {
    const list = document.querySelector("#chainEntryList")!, row = list.querySelector("button.active")!;
    const a = list.getBoundingClientRect(), b = row.getBoundingClientRect();
    return { scrolls: list.scrollHeight > list.clientHeight && list.scrollTop > 0, visible: b.top >= a.top - 1 && b.bottom <= a.bottom + 1 };
  });
  assert.deepEqual(fits, { scrolls: true, visible: true }, "the list scrolls to the active entry");
  assert.deepEqual(await page.locator("#chainSurface").boundingBox(), surfaceBeforeList, "scrolling the catalogue keeps the stage in place");
  await page.locator("#chainEntryList button").first().click();
  await page.locator("#chainEntryList").evaluate((node: HTMLElement) => { node.scrollTop = node.scrollHeight; });
  await applySource(long);
  assert.ok(await page.locator("#chainEntryList").evaluate((list: HTMLElement) => {
    const a = list.getBoundingClientRect(), b = list.querySelector("button.active")!.getBoundingClientRect();
    return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
  }), "re-importing brings the first entry back into view");
  await page.screenshot({ path: `${OUT}/entry-list.png` });
  await page.locator("#chainSection").selectOption("setPieceClasses");
  assert.equal(await page.locator("#chainEntryList button").count(), 0);
  assert.match(await page.locator("#chainEntryList").innerText(), /No entries/);
  await page.locator("#chainAdd").click();
  assert.deepEqual(await listed(), ["new-piece-class"], "adding to an empty section lists the entry");
  assert.equal(await active(), "new-piece-class");

  await applySource(entryBefore.library);
  await page.locator("#chainSection").selectOption(entryBefore.section);
  if (entryBefore.section === "tiles") await page.locator("#chainItem").selectOption(entryBefore.selectedId);
  else await page.locator(`#chainEntryList button[data-entry="${entryBefore.selectedId}"]`).click();
  assert.deepEqual(await page.evaluate(() => (window as any).chainLab.snapshot()), entryBefore, "the draft is restored for later checks");

  // Fill tool: flood fill stops at class boundaries
  await page.locator('.chain-swatch-button[data-class="arrival"]').click();
  await page.locator(".chain-gutter.cols button").nth(3).click();
  await page.locator('.chain-tool-group button[data-tool="fill"]').click();
  await page.locator('.chain-swatch-button[data-class="hut"]').click();
  await page.locator('#chainGrid [data-cell="0,0"]').click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  const hutMarkAfterFill = Object.entries(stageTile.legend ?? {}).find(
    ([, v]) => v === "hut",
  )?.[0];
  const arrivalMarkAfterFill = Object.entries(stageTile.legend ?? {}).find(
    ([, v]) => v === "arrival",
  )?.[0];
  assert.ok(hutMarkAfterFill, "hut mark exists in legend after fill");
  assert.ok(arrivalMarkAfterFill, "arrival mark exists in legend after fill");
  assert.equal(stageTile.cells[0][0], hutMarkAfterFill);
  assert.equal(stageTile.cells[0][2], hutMarkAfterFill);
  assert.equal(stageTile.cells[5][0], hutMarkAfterFill);
  assert.equal(stageTile.cells[5][2], hutMarkAfterFill);
  assert.equal(stageTile.cells[0][3], arrivalMarkAfterFill);
  assert.equal(stageTile.cells[5][3], arrivalMarkAfterFill);
  assert.equal(stageTile.cells[0][4], ".");
  assert.equal(stageTile.cells[5][5], ".");

  // Rect tool: reverse drag from bottom-right (4,4) to top-left (2,2)
  await page.locator('.chain-tool-group button[data-tool="rect"]').click();
  await page.locator('.chain-swatch-button[data-class="arrival"]').click();
  const cell44 = page.locator('#chainGrid [data-cell="4,4"]');
  const cell22 = page.locator('#chainGrid [data-cell="2,2"]');
  const box44 = (await cell44.boundingBox())!;
  const box22 = (await cell22.boundingBox())!;
  await page.mouse.move(box44.x + box44.width / 2, box44.y + box44.height / 2);
  await page.mouse.down();
  await page.mouse.move(box22.x + box22.width / 2, box22.y + box22.height / 2);
  await page.mouse.up();

  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  const arrivalMarkAfterRect = Object.entries(stageTile.legend ?? {}).find(
    ([, v]) => v === "arrival",
  )?.[0];
  for (let ry = 2; ry <= 4; ry++) {
    for (let rx = 2; rx <= 4; rx++) {
      assert.equal(
        stageTile.cells[ry][rx],
        arrivalMarkAfterRect,
        `cell ${rx},${ry} in rect is arrival`,
      );
    }
  }
  assert.equal(
    stageTile.cells[1][1],
    hutMarkAfterFill,
    "cell 1,1 outside rect remains hut",
  );

  // Clear painting resets cells and legend
  await page
    .locator(".chain-tool-group button", { hasText: "Clear painting" })
    .click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(stageTile.cells, undefined, "clearing painting removes cells");
  assert.equal(stageTile.legend, undefined, "clearing painting removes legend");

  // 1. In Paint mode, clicks right at the cell edge hit the cell, not the segment strip
  await page.locator('.chain-tool-group button[data-tool="paint"]').click();
  await page.locator('.chain-swatch-button[data-class="arrival"]').click();
  const cell00 = page.locator('#chainGrid [data-cell="0,0"]');
  const box00 = (await cell00.boundingBox())!;
  // Click 2px from right edge of cell (0,0) where vertical segment strip sits
  await page.mouse.click(box00.x + box00.width - 2, box00.y + box00.height / 2);
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  const arrivalMarkAtEdge = Object.entries(stageTile.legend ?? {}).find(
    ([, v]) => v === "arrival",
  )?.[0];
  assert.ok(arrivalMarkAtEdge, "cell painted arrival even when clicking right at the cell edge");
  assert.equal(stageTile.cells[0][0], arrivalMarkAtEdge, "cell 0,0 painted arrival at edge");
  // Clean up painting so we test segments cleanly
  await page
    .locator(".chain-tool-group button", { hasText: "Clear painting" })
    .click();

  // Canvas hotkeys, quick brush selection, search shortcut, and live hover readout (#317)
  // 1. Tool hotkeys: R (rect), F (fill), S (segments), D (paint)
  await page.keyboard.press("r");
  assert.ok(
    await page.locator('.chain-tool-group button[data-tool="rect"]').evaluate((el: HTMLElement) => el.classList.contains("active")),
    "pressing 'r' activates Rect tool",
  );
  await page.keyboard.press("f");
  assert.ok(
    await page.locator('.chain-tool-group button[data-tool="fill"]').evaluate((el: HTMLElement) => el.classList.contains("active")),
    "pressing 'f' activates Fill tool",
  );
  await page.keyboard.press("s");
  assert.ok(
    await page.locator('.chain-tool-group button[data-tool="segment"]').evaluate((el: HTMLElement) => el.classList.contains("active")),
    "pressing 's' activates Segments tool",
  );
  await page.keyboard.press("d");
  assert.ok(
    await page.locator('.chain-tool-group button[data-tool="paint"]').evaluate((el: HTMLElement) => el.classList.contains("active")),
    "pressing 'd' activates Paint tool",
  );

  // 2. Numeric brush switching (1..9)
  const swatchesCount = await page.locator(".chain-swatches .chain-swatch-button").count();
  assert.ok(swatchesCount >= 2, "palette has at least 2 cell classes");
  const secondClass = await page.locator(".chain-swatches .chain-swatch-button").nth(1).getAttribute("data-class");
  await page.keyboard.press("2");
  assert.equal(
    await page.locator(".chain-swatches .chain-swatch-button.active").getAttribute("data-class"),
    secondClass,
    "pressing '2' selects second declared cell class",
  );
  const firstClass = await page.locator(".chain-swatches .chain-swatch-button").nth(0).getAttribute("data-class");
  await page.keyboard.press("1");
  assert.equal(
    await page.locator(".chain-swatches .chain-swatch-button.active").getAttribute("data-class"),
    firstClass,
    "pressing '1' selects first declared cell class",
  );

  // 3. Search focus shortcut (/)
  await page.keyboard.press("/");
  assert.ok(
    await page.locator("#tileFilter").evaluate((el: HTMLElement) => el === document.activeElement),
    "pressing '/' focuses tile filter input",
  );
  await page.locator("#tileFilter").blur();

  // 4. Live stage hover readout (#chainHoverReadout)
  await cell00.hover();
  const hoverText = await page.locator("#chainHoverReadout").innerText();
  assert.match(hoverText, /Cell 0,0/, "stage hover readout displays cell coordinates on hover");

  // Interactive segment editor tests (#304): on-stage segments, indicators, brush, drag, popup, patterns
  // 2. Select segment from list outside segment mode to inspect existing attributes
  await page.locator('#chainSegments button[data-segment="v:0,1"]').click();
  const stageSegV01 = page.locator(
    '.chain-stage-segment[data-stage-segment="v:0,1"]',
  );
  assert.ok(
    await stageSegV01.evaluate((el: HTMLElement) => el.classList.contains("selected")),
    "selected segment in list updates on-stage selected class",
  );
  assert.equal(
    await page.locator("#chainSegmentPassability").inputValue(),
    "not-passable-hint",
    "inspector reflects selected stage segment passability",
  );
  assert.ok(
    await stageSegV01.evaluate((el: HTMLElement) => el.classList.contains("wall")),
    "not-passable-hint segment has wall class",
  );
  assert.match(
    await page.locator(".chain-segment-controls .chain-badge").innerText(),
    /Perimeter/i,
    "perimeter badge is shown",
  );
  assert.equal(
    await page.locator("#chainSegmentAperture").count(),
    0,
    "aperture input is omitted; aperture geometry deferred in chain v3",
  );
  assert.match(
    await page.locator(".chain-segment-controls").innerText(),
    /A facing passable statement still guarantees a crossing/,
    "inspector includes complete crossing contract guidance",
  );

  // 3. Change passability via inspector and check on-stage indicator changes
  await page.locator("#chainSegmentPassability").selectOption("passable");
  assert.ok(
    await stageSegV01.evaluate((el: HTMLElement) => el.classList.contains("passable")),
    "passable segment has passable class",
  );
  await page.locator("#chainSegmentPassability").selectOption("any");
  assert.ok(
    await stageSegV01.evaluate((el: HTMLElement) => el.classList.contains("any")),
    "any segment has any class",
  );

  // 4. Adjacency dot indicator on perimeter segment
  await page.locator("#chainSegmentAdjacency").selectOption("arrival");
  assert.ok(
    await stageSegV01.locator(".chain-adj-dot").isVisible(),
    "perimeter segment with adjacency displays adjacency indicator dot",
  );

  // 5. Switch to segment mode and stamp on-stage segment with brush
  await page.locator('.chain-tool-group button[data-tool="segment"]').click();
  await page
    .locator('.chain-seg-brushes button[data-seg-brush="passable"]')
    .click();
  const stageSegH13 = page.locator(
    '.chain-stage-segment[data-stage-segment="h:1,3"]',
  );
  await stageSegH13.click();
  assert.ok(
    await stageSegH13.evaluate((el: HTMLElement) => el.classList.contains("passable")),
    "clicking with passable segment brush sets passable state",
  );
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(
    stageTile.segments?.["h:1,3"]?.passability,
    "passable",
    "tile snapshot records passable prescription on h:1,3",
  );

  // 6. Segment drag-brushing across boundary
  await page
    .locator('.chain-seg-brushes button[data-seg-brush="not-passable-hint"]')
    .click();
  const gridEl = page.locator("#chainGrid");
  const gBox = (await gridEl.boundingBox())!;
  const cellWidth = gBox.width / 6;
  const cellHeight = gBox.height / 6;
  const dragY = gBox.y + cellHeight * 2.5;
  await page.mouse.move(gBox.x + cellWidth * 2.8, dragY);
  await page.mouse.down();
  await page.mouse.move(gBox.x + cellWidth * 3.2, dragY);
  await page.mouse.up();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(
    stageTile.segments?.["v:3,2"]?.passability,
    "not-passable-hint",
    "drag-brushing across boundary stamps segment v:3,2 with wall hint",
  );

  // 7. Right-click contextmenu popup
  const stageSegH22 = page.locator(
    '.chain-stage-segment[data-stage-segment="h:2,2"]',
  );
  await stageSegH22.click({ button: "right" });
  const popup = page.locator(".chain-popup");
  assert.ok(await popup.isVisible(), "right-click opens contextmenu popup");
  await popup.locator("button", { hasText: "Passable" }).click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(
    stageTile.segments?.["h:2,2"]?.passability,
    "passable",
    "contextmenu popup selection updates segment passability",
  );

  // 8. Segment patterns: Perim Walls and Clear Segments
  await page
    .locator(".chain-tool-group button", { hasText: "Perim Walls" })
    .click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(
    stageTile.segments?.["v:0,0"]?.passability,
    "not-passable-hint",
    "Perim Walls sets v:0,0 to wall hint",
  );
  assert.equal(
    stageTile.segments?.["h:6,5"]?.passability,
    "not-passable-hint",
    "Perim Walls sets h:6,5 to wall hint",
  );

  await page
    .locator(".chain-tool-group button", { hasText: "Clear Segments" })
    .click();
  stageTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().library.tiles[0],
  );
  assert.equal(
    stageTile.segments,
    undefined,
    "Clear Segments removes all segment prescriptions (both passability and perimeter adjacency)",
  );

  // Restore chainDraft for subsequent class-deletion assertions
  await page.locator("#chainImport").setInputFiles([]);
  await page.locator("#chainImport").setInputFiles(chainPath);
  await page.waitForFunction(() => (window as any).chainLab.snapshot().valid);
  // Visual tile gallery, thumbnails, and template cloning tests (#305)
  // 1. Gallery cards rendering and active state
  assert.ok(
    await page.locator("#chainTileGallerySection").isVisible(),
    "tile gallery section is visible when section is tiles",
  );
  const initialTileCount = await page.locator("#tileGallery .tile-card").count();
  assert.ok(initialTileCount > 0, "tile gallery renders cards for library tiles");
  const initialSelectedTile = await page.evaluate(
    () => (window as any).chainLab.snapshot().selectedId,
  );
  assert.ok(
    await page
      .locator(`#tileGallery .tile-card[data-tile="${initialSelectedTile}"]`)
      .evaluate((el: HTMLElement) => el.classList.contains("active")),
    "active tile card corresponds to selectedId",
  );
  assert.equal(
    await page.locator(`#tileGallery .tile-card[data-tile="${initialSelectedTile}"] figure i`).count(),
    36,
    "tile thumbnail renders 36 cells",
  );

  // 2. Select different tile from gallery
  const secondTileCard = page.locator("#tileGallery .tile-card").nth(1);
  const secondTileId = (await secondTileCard.getAttribute("data-tile"))!;
  await secondTileCard.click();
  assert.equal(
    await page.locator("#chainItem").inputValue(),
    secondTileId,
    "clicking gallery card updates dropdown selection",
  );
  assert.ok(
    await secondTileCard.evaluate((el: HTMLElement) => el.classList.contains("active")),
    "clicked gallery card receives active class",
  );

  // 3. Search and filter gallery cards
  await page.locator("#tileFilter").fill(initialSelectedTile);
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    1,
    "filtering by tile ID narrows gallery to matching card",
  );
  assert.equal(
    await page.locator("#tileGallery .tile-card").getAttribute("data-tile"),
    initialSelectedTile,
    "filtered card has expected ID",
  );

  await page.locator("#tileFilter").fill("nonexistent-tile-query-xyz");
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    0,
    "non-matching filter hides all cards",
  );
  assert.match(
    await page.locator("#tileGallery .gallery-empty").innerText(),
    /No tile matches/,
    "empty notice is shown for non-matching query",
  );

  await page.locator("#tileFilter").fill("");
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    initialTileCount,
    "clearing filter restores all tile cards",
  );

  // 4. Duplicate / Clone tile while filter is active
  await page.locator("#tileFilter").fill(secondTileId);
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    1,
    "filtering narrows to single target card",
  );
  await page.locator("#cloneTemplate").click();
  const clonedTileId = await page.evaluate(
    () => (window as any).chainLab.snapshot().selectedId,
  );
  assert.match(
    clonedTileId,
    new RegExp(`^${secondTileId}-\\d+$`),
    "cloned tile ID uses suffixed base",
  );
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    2,
    "cloned tile matches filter prefix and remains visible alongside parent",
  );
  assert.ok(
    await page
      .locator(`#tileGallery .tile-card[data-tile="${clonedTileId}"]`)
      .evaluate((el: HTMLElement) => el.classList.contains("active")),
    "cloned tile card is active in gallery",
  );

  await page.locator("#tileFilter").fill("");
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    initialTileCount + 1,
    "clearing filter restores all tile cards including clone",
  );

  // 5. Delete cloned tile with confirmation
  page.once("dialog", (dialog: any) => dialog.accept());
  await page.locator("#chainDelete").click();
  assert.equal(
    await page.locator("#tileGallery .tile-card").count(),
    initialTileCount,
    "deleting tile removes card from gallery",
  );

  // 6. Rename tile referenced in tile sets with confirmation warning and automatic reference update
  const tileToRename = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const referencedTile = snap.library.tiles.find((t: any) =>
      snap.library.tileSets.some((s: any) => s.members.includes(t.id)),
    );
    return referencedTile?.id;
  });
  assert.ok(tileToRename, "found a tile referenced in tileSets");
  await page.locator("#chainItem").selectOption(tileToRename);
  const setsReferencingBefore = await page.evaluate(
    (tileId: string) => {
      const snap = (window as any).chainLab.snapshot();
      return snap.library.tileSets
        .filter((s: any) => s.members.includes(tileId))
        .map((s: any) => s.id);
    },
    tileToRename,
  );
  assert.ok(setsReferencingBefore.length > 0, "tile is referenced by at least one tile set");

  // First dismiss (cancel) rename confirmation dialog
  page.once("dialog", (dialog: any) => dialog.dismiss());
  await page.locator("#chainId").fill(`${tileToRename}-aborted`);
  await page.locator("#chainId").blur();
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().selectedId),
    tileToRename,
    "canceling dialog preserves original tile ID",
  );
  assert.equal(
    await page.locator("#chainId").inputValue(),
    tileToRename,
    "input reverts to original tile ID after cancel",
  );

  // Now accept rename confirmation dialog
  const renamedTileId = `${tileToRename}-renamed`;
  let renameDialogMsg = "";
  page.once("dialog", (dialog: any) => {
    renameDialogMsg = dialog.message();
    dialog.accept();
  });
  await page.locator("#chainId").fill(renamedTileId);
  await page.locator("#chainId").blur();

  assert.equal(
    renameDialogMsg,
    `Rename tile design "${tileToRename}" to "${renamedTileId}"? It is referenced in tile set(s): ${setsReferencingBefore.join(", ")}. References will be updated automatically.`,
    "rename confirmation dialog message matches expected warning",
  );
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().selectedId),
    renamedTileId,
    "selected ID is updated to renamed tile ID",
  );
  assert.equal(
    await page.locator("#chainItem").inputValue(),
    renamedTileId,
    "selector dropdown reflects renamed tile",
  );
  assert.ok(
    await page.locator(`#tileGallery .tile-card[data-tile="${renamedTileId}"]`).isVisible(),
    "tile gallery reflects renamed tile card",
  );
  const setsReferencingAfter = await page.evaluate(
    (nextId: string) => {
      const snap = (window as any).chainLab.snapshot();
      return snap.library.tileSets
        .filter((s: any) => s.members.includes(nextId))
        .map((s: any) => s.id);
    },
    renamedTileId,
  );
  assert.deepEqual(
    setsReferencingAfter,
    setsReferencingBefore,
    "tile set members list was updated automatically with the renamed tile ID",
  );

  // Visual Tile Sets manager with membership and available tile galleries (#306)
  await page.locator("#chainSection").selectOption("tileSets");
  assert.equal(
    await page.locator("#chainTileGallerySection").isVisible(),
    false,
    "tile design gallery is hidden in tileSets section",
  );
  assert.ok(
    await page.locator("#setMembersGallery").isVisible(),
    "members gallery is visible in tileSets section",
  );
  assert.ok(
    await page.locator("#setAvailableGallery").isVisible(),
    "available gallery is visible in tileSets section",
  );

  const selectedSetId = await page.evaluate(
    () => (window as any).chainLab.snapshot().selectedId,
  );
  const activeSetInfo = await page.evaluate((id: string) => {
    const snap = (window as any).chainLab.snapshot();
    const set = snap.library.tileSets.find((s: any) => s.id === id);
    return {
      membersCount: set.members.length,
      availableCount: snap.library.tiles.length - set.members.length,
      firstMember: set.members[0],
    };
  }, selectedSetId);

  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    activeSetInfo.membersCount,
    "members gallery renders cards for set members",
  );
  assert.equal(
    await page.locator("#setAvailableGallery .tile-card").count(),
    activeSetInfo.availableCount,
    "available gallery renders cards for non-member tiles",
  );
  assert.equal(
    await page.locator("#setMembersGallery .tile-card figure i").count(),
    activeSetInfo.membersCount * 36,
    "member cards render 6x6 thumbnail grids",
  );

  // Add an available tile to the set
  const firstAvailableCard = page.locator("#setAvailableGallery .tile-card").first();
  const tileToAdd = (await firstAvailableCard.getAttribute("data-tile"))!;
  await firstAvailableCard.click();

  assert.equal(
    await page.evaluate(
      (args: { setId: string; tileId: string }) => {
        const snap = (window as any).chainLab.snapshot();
        const set = snap.library.tileSets.find((s: any) => s.id === args.setId);
        return set.members.includes(args.tileId);
      },
      { setId: selectedSetId, tileId: tileToAdd },
    ),
    true,
    "clicking available tile adds it to set members",
  );
  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    activeSetInfo.membersCount + 1,
    "members gallery count increments",
  );
  assert.ok(
    await page.locator(`#setMembersGallery .tile-card[data-tile="${tileToAdd}"]`).isVisible(),
    "added tile is visible in members gallery",
  );
  assert.equal(
    await page.locator(`#setAvailableGallery .tile-card[data-tile="${tileToAdd}"]`).count(),
    0,
    "added tile is removed from available gallery",
  );

  // Add all available tiles to test "All library tiles are members" state robustly. Return the
  // tile just added first, so the loop has at least one card to take; it ends in the same state.
  await page.locator(`#setMembersGallery .tile-card[data-tile="${tileToAdd}"]`).click();
  // Bounded by the starting count, and each click must take one tile, so a stuck gallery fails here.
  const availableCards = page.locator("#setAvailableGallery .tile-card");
  const initialAvailable = await availableCards.count();
  assert.ok(initialAvailable > 0, "the bulk add starts with available tiles");
  for (let remaining = initialAvailable; remaining > 0; remaining--) {
    await availableCards.first().click();
    assert.equal(
      await availableCards.count(),
      remaining - 1,
      `adding an available tile leaves ${remaining - 1} of ${initialAvailable}`,
    );
  }
  assert.equal(
    await page.locator("#setAvailableGallery .tile-card").count(),
    0,
    "no tiles left in available gallery after adding all",
  );
  assert.match(
    await page.locator("#setAvailableGallery .gallery-empty").innerText(),
    /All library tiles are members of this set/,
    "empty notice is shown when all tiles are members",
  );

  // Remove the newly added tile from the set
  await page.locator(`#setMembersGallery .tile-card[data-tile="${tileToAdd}"]`).click();
  assert.equal(
    await page.evaluate(
      (args: { setId: string; tileId: string }) => {
        const snap = (window as any).chainLab.snapshot();
        const set = snap.library.tileSets.find((s: any) => s.id === args.setId);
        return set.members.includes(args.tileId);
      },
      { setId: selectedSetId, tileId: tileToAdd },
    ),
    false,
    "clicking member tile removes it from set members",
  );
  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    activeSetInfo.membersCount,
    "members gallery count decrements",
  );
  assert.ok(
    await page.locator(`#setAvailableGallery .tile-card[data-tile="${tileToAdd}"]`).isVisible(),
    "removed tile returns to available gallery",
  );

  // Filter available gallery
  await page.locator("#setAvailableFilter").fill("nonexistent-tile-xyz");
  assert.equal(
    await page.locator("#setAvailableGallery .tile-card").count(),
    0,
    "non-matching query yields no cards",
  );
  assert.match(
    await page.locator("#setAvailableGallery .gallery-empty").innerText(),
    /No available tiles match/,
    "empty notice is shown for matching query with no results",
  );
  await page.locator("#setAvailableFilter").fill(tileToAdd);
  assert.equal(
    await page.locator("#setAvailableGallery .tile-card").count(),
    1,
    "filter narrows to matching available card",
  );
  await page.locator("#setAvailableFilter").fill("");
  assert.equal(
    await page.locator("#setAvailableGallery .tile-card").count(),
    activeSetInfo.availableCount,
    "clearing filter restores available cards",
  );

  // Non-empty set validation enforcement
  await page.locator("#chainAdd").click();
  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    1,
    "newly added tile set has exactly 1 initial member",
  );
  // Try to remove the only member
  await page.locator("#setMembersGallery .tile-card").first().click();
  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    1,
    "attempting to remove the only member is prevented",
  );
  assert.match(
    await page.locator("#chainStatus").innerText(),
    /must have at least one member to remain valid/,
    "status bar warns that tile set must have at least one member",
  );

  // Add a second member and then removal is allowed
  const secondTileToAdd = (await page.locator("#setAvailableGallery .tile-card").first().getAttribute("data-tile"))!;
  await page.locator("#setAvailableGallery .tile-card").first().click();
  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    2,
    "set now has 2 members",
  );
  await page.locator(`#setMembersGallery .tile-card[data-tile="${secondTileToAdd}"]`).click();
  assert.equal(
    await page.locator("#setMembersGallery .tile-card").count(),
    1,
    "removing member when multiple exist succeeds",
  );

  // Clean up: delete the test set
  page.once("dialog", (dialog: any) => dialog.accept());
  await page.locator("#chainDelete").click();

  // Test renaming a tile set that is referenced in set pieces
  await page.locator('#chainEntryList button[data-entry="new-set"]').click();
  const piecesReferencing = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    return snap.library.setPieces
      .filter((p: any) => p.tiles.some((slot: any) => slot.tileSetId === "new-set"))
      .map((p: any) => p.id);
  });
  assert.ok(piecesReferencing.length > 0, "new-set is referenced in setPieces");

  // Dismiss rename
  page.once("dialog", (dialog: any) => dialog.dismiss());
  await page.locator("#chainId").fill("new-set-aborted");
  await page.locator("#chainId").blur();
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().selectedId),
    "new-set",
    "canceling rename keeps original set ID",
  );

  // Accept rename
  let renameDialogText = "";
  page.once("dialog", (dialog: any) => {
    renameDialogText = dialog.message();
    dialog.accept();
  });
  await page.locator("#chainId").fill("new-set-renamed");
  await page.locator("#chainId").blur();
  assert.equal(
    renameDialogText,
    `Rename tile set "new-set" to "new-set-renamed"? It is referenced in set piece(s): ${piecesReferencing.join(", ")}. References will be updated automatically.`,
    "rename dialog warns about referenced set pieces",
  );
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().selectedId),
    "new-set-renamed",
    "selectedId updated to new-set-renamed",
  );
  const updatedSlotSet = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === "new-piece");
    return piece?.tiles[0]?.tileSetId;
  });
  assert.equal(
    updatedSlotSet,
    "new-set-renamed",
    "set piece slot tileSetId was updated automatically",
  );

  // Test delete cascade strips referencing slots from set pieces
  let deleteCascadeDialogText = "";
  page.once("dialog", (dialog: any) => {
    deleteCascadeDialogText = dialog.message();
    dialog.accept();
  });
  await page.locator("#chainDelete").click();
  assert.match(
    deleteCascadeDialogText,
    /Referencing slot\(s\) will be removed automatically/,
    "delete dialog warns about stripping slots from set pieces",
  );
  const slotsAfterDelete = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === "new-piece");
    return piece?.tiles.filter((slot: any) => slot.tileSetId === "new-set-renamed").length ?? 0;
  });
  assert.equal(
    slotsAfterDelete,
    0,
    "referencing slots were stripped from set piece on tile set deletion",
  );

  // A set piece left with empty tiles is rejected by validateLibrary
  const draftValidityAfterStrip = await page.evaluate(() => {
    return (window as any).chainLab.snapshot().valid;
  });
  assert.equal(
    draftValidityAfterStrip,
    false,
    "a set piece left with 0 tile slots is rejected by validateLibrary",
  );
  assert.match(
    await page.locator("#chainStatus").innerText(),
    /set piece new-piece: missing tile slots/,
    "status bar flags missing tile slots on the stripped set piece",
  );

  // Add a second tile set to test set piece palette filtering and numeric hotkeys
  await page.locator("#chainAdd").click();

  // Visual Set Pieces layout grid editor (#315)
  await page.locator("#chainSection").selectOption("setPieces");
  await page.locator('#chainEntryList button[data-entry="new-piece"]').click();
  assert.ok(
    await page.locator("#setPieceGrid").isVisible(),
    "set piece blueprint grid is visible in setPieces section",
  );
  assert.ok(
    await page.locator("#setPiecePaletteList").isVisible(),
    "tile sets palette is visible in setPieces section",
  );
  assert.ok(
    await page.locator("#chainEligibleTiers").isVisible(),
    "eligible tiers checkboxes are visible",
  );

  // 1. Palette filtering and selection
  const initialPaletteCount = await page.locator("#setPiecePaletteList .chain-layout-palette-item").count();
  assert.ok(initialPaletteCount >= 2, "palette lists at least 2 tile sets");
  const firstPaletteItem = page.locator("#setPiecePaletteList .chain-layout-palette-item").first();
  const firstPaletteSet = (await firstPaletteItem.getAttribute("data-tileset"))!;
  await firstPaletteItem.click();
  assert.ok(
    await firstPaletteItem.evaluate((el: HTMLElement) => el.classList.contains("active")),
    "clicked palette item becomes active brush",
  );

  const secondPaletteItem = page.locator("#setPiecePaletteList .chain-layout-palette-item").nth(1);
  const secondPaletteSet = (await secondPaletteItem.getAttribute("data-tileset"))!;

  await page.locator("#setPiecePaletteFilter").fill(secondPaletteSet);
  assert.equal(
    await page.locator("#setPiecePaletteList .chain-layout-palette-item").count(),
    1,
    "filtering palette narrows to matching tile set",
  );
  await page.locator("#setPiecePaletteFilter").blur();
  await page.keyboard.press("1");
  const activePaletteSet = await page
    .locator("#setPiecePaletteList .chain-layout-palette-item.active")
    .getAttribute("data-tileset");
  assert.equal(
    activePaletteSet,
    secondPaletteSet,
    "pressing '1' with filter applied selects the first filtered tile set",
  );

  await page.keyboard.press("/");
  assert.ok(
    await page.locator("#setPiecePaletteFilter").evaluate((el: HTMLElement) => el === document.activeElement),
    "pressing '/' focuses set piece palette filter",
  );

  await page.locator("#setPiecePaletteFilter").fill("");
  assert.equal(
    await page.locator("#setPiecePaletteList .chain-layout-palette-item").count(),
    initialPaletteCount,
    "clearing palette filter restores all items",
  );
  await firstPaletteItem.click();

  // 2. Eligible tiers checkboxes (tiers 1-5)
  const tier1Box = page.locator('#chainEligibleTiers input[data-tier="1"]');
  const tier3Box = page.locator('#chainEligibleTiers input[data-tier="3"]');
  await tier1Box.check();
  await tier3Box.check();
  let currentPieceTiers = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === snap.selectedId);
    return piece?.eligibleTiers;
  });
  assert.deepEqual(currentPieceTiers, [1, 3], "checking tier boxes updates piece.eligibleTiers");

  await tier1Box.uncheck();
  await tier3Box.uncheck();
  currentPieceTiers = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === snap.selectedId);
    return piece?.eligibleTiers;
  });
  assert.equal(currentPieceTiers, undefined, "unchecking all tiers leaves eligibleTiers undefined");

  // 3. Grid cell painting, rotation, and erasing
  const targetCell = page.locator('#setPieceGrid [data-dx="2"][data-dy="2"]');
  assert.equal(
    await targetCell.evaluate((el: HTMLElement) => el.classList.contains("filled")),
    false,
    "target cell starts empty",
  );

  // Left click empty cell: place slot
  await targetCell.click();
  assert.equal(
    await targetCell.evaluate((el: HTMLElement) => el.classList.contains("filled")),
    true,
    "cell is filled after clicking with active brush",
  );
  assert.ok(
    await targetCell.locator(".slot-thumbnail").isVisible(),
    "cell displays member tile thumbnail preview",
  );
  assert.equal(
    await targetCell.locator(".slot-set-id").innerText(),
    firstPaletteSet,
    "cell displays placed tile set ID",
  );
  assert.equal(
    await targetCell.locator(".slot-rot").innerText(),
    "0°",
    "cell displays initial 0° orientation",
  );

  // Left click filled cell: cycle rotation to 90°
  await targetCell.click();
  assert.ok(
    (await targetCell.locator(".slot-thumbnail").getAttribute("style"))?.includes("rotate(90deg)"),
    "thumbnail rotates with slot orientation",
  );
  assert.equal(
    await targetCell.locator(".slot-rot").innerText(),
    "90°",
    "clicking filled cell rotates slot to 90°",
  );
  let slotRotInSnap = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === snap.selectedId);
    return piece?.tiles.find((s: any) => s.dx === 2 && s.dy === 2)?.orientation;
  });
  assert.equal(slotRotInSnap, 90, "snapshot reflects 90° orientation");

  // Keyboard navigation on grid cell: Enter rotates to 180°, Space rotates to 270°, Delete erases
  await targetCell.press("Enter");
  assert.equal(
    await targetCell.locator(".slot-rot").innerText(),
    "180°",
    "pressing Enter on filled cell rotates to 180°",
  );
  await targetCell.press("Space");
  assert.equal(
    await targetCell.locator(".slot-rot").innerText(),
    "270°",
    "pressing Space on filled cell rotates to 270°",
  );
  await targetCell.press("Delete");
  assert.equal(
    await targetCell.evaluate((el: HTMLElement) => el.classList.contains("filled")),
    false,
    "pressing Delete on filled cell erases slot",
  );
  const slotAfterErase = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === "new-piece");
    return piece?.tiles.find((s: any) => s.dx === 2 && s.dy === 2);
  });
  assert.equal(slotAfterErase, undefined, "slot is removed from draft");

  // Keyboard placement on empty cell: Enter places active brush
  await targetCell.press("Enter");
  assert.equal(
    await targetCell.evaluate((el: HTMLElement) => el.classList.contains("filled")),
    true,
    "pressing Enter on empty cell places active brush",
  );

  // Dynamic grid expansion beyond ±5: placing on boundary cell (5, 5) expands grid margin
  const boundaryCell = page.locator('#setPieceGrid [data-dx="5"][data-dy="5"]');
  await boundaryCell.click();
  assert.equal(
    await boundaryCell.evaluate((el: HTMLElement) => el.classList.contains("filled")),
    true,
    "placed slot at boundary coordinate (5, 5)",
  );
  assert.ok(
    await page.locator('#setPieceGrid [data-dx="6"][data-dy="6"]').isVisible(),
    "grid bounds dynamically expand beyond ±5 with 1-cell border margin",
  );

  // Right-click to erase slots
  await boundaryCell.click({ button: "right" });
  await targetCell.click({ button: "right" });
  assert.equal(
    await targetCell.evaluate((el: HTMLElement) => el.classList.contains("filled")),
    false,
    "right-clicking cell erases placed slot",
  );

  // Enforce validateLibrary check on set piece left with 0 tile slots (#315)
  const pieceSlotsCount = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const piece = snap.library.setPieces.find((p: any) => p.id === "new-piece");
    return piece?.tiles.length;
  });
  assert.equal(pieceSlotsCount, 0, "new-piece has 0 tile slots after erasing");
  assert.equal(
    await page.evaluate(() => (window as any).chainLab.snapshot().valid),
    false,
    "set piece left with 0 tile slots is rejected by validateLibrary",
  );
  assert.match(
    await page.locator("#chainStatus").innerText(),
    /set piece new-piece: missing tile slots/,
    "status bar flags missing tile slots on set piece after right-click erase",
  );

  // 4. Referencing Set Piece Classes section and class binding
  assert.ok(
    await page.locator("#chainPieceClassesSection").isVisible(),
    "referencing set piece classes section is visible",
  );
  const classRow = page.locator('#chainPieceClassesList .chain-piece-class-row[data-class-id="new-piece-class"]');
  assert.ok(
    await classRow.isVisible(),
    "new-piece-class set piece class row is rendered",
  );
  assert.ok(
    await classRow.locator(".rule-badge").isVisible(),
    "placement rule badge is rendered",
  );
  assert.ok(
    await classRow.locator(".quota-badge").isVisible(),
    "quota badge is rendered",
  );

  // Toggle class binding checkbox
  const classCheckbox = classRow.locator('input[type="checkbox"]');
  const wasChecked = await classCheckbox.isChecked();
  assert.equal(wasChecked, true, "new-piece starts checked in new-piece-class");
  await classCheckbox.click();
  assert.equal(await classCheckbox.isChecked(), false, "clicking checkbox unchecks membership");
  let inClassSnapshot = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const cls = snap.library.setPieceClasses.find((c: any) => c.id === "new-piece-class");
    return cls?.setPieces.includes("new-piece");
  });
  assert.equal(inClassSnapshot, false, "snapshot reflects removed class membership");

  // Re-check so new-piece is referenced by new-piece-class for the delete warning test below
  await classCheckbox.click();
  assert.equal(await classCheckbox.isChecked(), true, "clicking checkbox again restores membership");
  inClassSnapshot = await page.evaluate(() => {
    const snap = (window as any).chainLab.snapshot();
    const cls = snap.library.setPieceClasses.find((c: any) => c.id === "new-piece-class");
    return cls?.setPieces.includes("new-piece");
  });
  assert.equal(inClassSnapshot, true, "snapshot reflects restored class membership");

  // Click edit class button to navigate to setPieceClasses section
  await classRow.locator(".piece-class-link-btn").click();
  const navSection = await page.evaluate(() => (window as any).chainLab.snapshot().section);
  const navSelected = await page.evaluate(() => (window as any).chainLab.snapshot().selectedId);
  assert.equal(navSection, "setPieceClasses", "clicking edit class button navigates to setPieceClasses section");
  assert.equal(navSelected, "new-piece-class", "navigated to new-piece-class set piece class");

  // Verify placement rule options include transit derived from PLACEMENT_RULES
  const ruleOptions = await page.locator("#chainPlacementRule option").allTextContents();
  assert.ok(ruleOptions.includes("transit"), "placement rule choices include transit");

  // Return to setPieces section and new-piece for the delete test
  await page.locator("#chainSection").selectOption("setPieces");
  await page.locator('#chainEntryList button[data-entry="new-piece"]').click();

  // 5. Set piece delete confirmation warning when referenced by set piece classes
  const classesUsingPiece = await page.evaluate((id: string) => {
    const snap = (window as any).chainLab.snapshot();
    return snap.library.setPieceClasses
      .filter((c: any) => c.setPieces.includes(id))
      .map((c: any) => c.id);
  }, "new-piece");
  assert.ok(classesUsingPiece.length > 0, "new-piece is referenced by set piece classes");

  let deletePieceMsg = "";
  page.once("dialog", (dialog: any) => {
    deletePieceMsg = dialog.message();
    dialog.accept();
  });
  await page.locator("#chainDelete").click();
  assert.match(
    deletePieceMsg,
    new RegExp(`Delete set piece "new-piece"\\? It is referenced in set piece class\\(es\\): ${classesUsingPiece.join(", ")}\\. References will be removed automatically\\.`),
    "delete set piece dialog warns about referencing set piece classes",
  );
  const classesStillReferencing = await page.evaluate((id: string) => {
    const snap = (window as any).chainLab.snapshot();
    return snap.library.setPieceClasses
      .filter((c: any) => c.setPieces.includes("new-piece"))
      .map((c: any) => c.id);
  });
  assert.equal(classesStillReferencing.length, 0, "references in setPieceClasses were cleaned up");

  await page.screenshot({
    path: `${OUT}/chain-authoring.png`,
    fullPage: true,
  });
  await page.locator("#chainSection").selectOption("classes");
  assert.equal(
    await page.locator("#chainTileGallerySection").isVisible(),
    false,
    "tile gallery is hidden outside tiles section",
  );
  await page.locator('#chainEntryList button[data-entry="open"]').click();
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
  // #538: typing in property fields keeps focus and caret, and an edit leaves the paint stage and
  // unrelated thumbnails as built. A fresh context starts from the starter library.
  {
    const editPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    editPage.on("pageerror", (error: Error) => errors.push(error.message));
    await editPage.goto(base, { waitUntil: "domcontentloaded" });
    await editPage.waitForFunction(() => !!(window as any).chainLab);
    await editPage.locator("#chainTab").click();
    await editPage.locator("#chainSection").selectOption("tiles");
    await editPage.locator("#chainClone").click();
    await editPage.locator('#tileGallery .tile-card[data-tile="half-hut"]').click();
    const draft = () => editPage.evaluate(() => (window as any).chainLab.snapshot());
    const focusedId = () => editPage.evaluate(() => document.activeElement?.id);
    // Mark the stage and both thumbnails; a rebuilt node loses its mark.
    const mark = () => editPage.evaluate(() => {
      for (const node of [document.querySelector("#chainGrid"), ...document.querySelectorAll("#tileGallery figure")])
        (node as any).keep538 = true;
    });
    const kept = () => editPage.evaluate(() => ({
      stage: !!(document.querySelector("#chainGrid") as any)?.keep538,
      selected: !!(document.querySelector('#tileGallery .tile-card.active figure') as any)?.keep538,
      other: !!(document.querySelector('#tileGallery .tile-card:not(.active) figure') as any)?.keep538,
    }));
    await mark();
    await editPage.locator("#chainTiers").click();
    await editPage.keyboard.type("1, 2");
    await editPage.keyboard.press("Tab");
    assert.equal(await focusedId(), "chainBonus", "Tab after a committed field reaches the next field");
    await editPage.keyboard.type("3");
    await editPage.keyboard.press("Tab");
    assert.equal(await focusedId(), "chainLabels");
    await editPage.keyboard.type("alpha, beta");
    await editPage.keyboard.press("Enter");
    assert.equal(await focusedId(), "chainLabels", "Enter commits without losing focus");
    assert.deepEqual(await editPage.locator("#chainLabels").evaluate((input: HTMLInputElement) =>
      [input.selectionStart, input.value.length]), [11, 11], "caret stays where typing left it");
    await editPage.keyboard.type(", gamma");
    await editPage.keyboard.press("Enter");
    let tile = (await draft()).library.tiles[0];
    assert.deepEqual([tile.eligibleTiers, tile.eligibleBonus, tile.labels], [[1, 2], [3], ["alpha", "beta", "gamma"]]);
    assert.deepEqual(await kept(), { stage: true, selected: true, other: true }, "property edits rebuild no stage or thumbnail");
    assert.match(await editPage.locator("#chainSource").inputValue(), /"gamma"/, "the source view follows edits");

    // A related property redraws in place: the stage's cells and only its own thumbnail.
    await editPage.locator("#chainDefaultClass").selectOption("arrival");
    assert.equal(await editPage.locator('#chainGrid [data-cell="0,0"]').innerText(), "arrival");
    assert.deepEqual(await kept(), { stage: true, selected: false, other: true });
    await editPage.locator("#chainDefaultClass").selectOption("open");
    await mark();

    // Invalid values reach the draft and its validation, and fixing them clears it.
    await editPage.locator("#chainTiers").fill("9");
    await editPage.locator("#chainTiers").press("Enter");
    assert.equal((await draft()).valid, false);
    assert.match(await editPage.locator("#chainStatus").innerText(), /validation issue/);
    await editPage.locator("#chainTiers").fill("");
    await editPage.locator("#chainTiers").press("Enter");
    assert.equal((await draft()).valid, true);
    assert.equal(await focusedId(), "chainTiers");

    // Renaming keeps focus and updates the entry list, the gallery and references. Declining the
    // reference warning redraws the old name into the focused field.
    editPage.once("dialog", (dialog: any) => dialog.dismiss());
    await editPage.locator("#chainId").fill("hut-left");
    await editPage.locator("#chainId").press("Enter");
    assert.equal(await focusedId(), "chainId");
    assert.equal(await editPage.locator("#chainId").inputValue(), "half-hut");
    await mark();
    editPage.once("dialog", (dialog: any) => dialog.accept());
    await editPage.locator("#chainId").fill("hut-left");
    await editPage.locator("#chainId").press("Enter");
    assert.equal(await focusedId(), "chainId");
    let snap = await draft();
    assert.equal(snap.selectedId, "hut-left");
    assert.equal(await editPage.locator("#chainItem").inputValue(), "hut-left");
    assert.equal(await editPage.locator("#tileGallery .tile-card.active").getAttribute("data-tile"), "hut-left");
    assert.deepEqual(snap.library.tileSets[0].members, ["hut-left"]);
    // A refused name keeps its text and the reason, and leaves the draft alone.
    await editPage.locator("#chainId").fill("half-hut-1");
    await editPage.locator("#chainId").press("Enter");
    assert.match(await editPage.locator("#chainStatus").innerText(), /Name must be unique/);
    assert.equal(await editPage.locator("#chainId").inputValue(), "half-hut-1");
    assert.equal((await draft()).selectedId, "hut-left");
    assert.deepEqual(await kept(), { stage: true, selected: true, other: true });
    // The next committed edit elsewhere shows the real ID again.
    await editPage.locator("#chainWeight").fill("2");
    await editPage.locator("#chainWeight").press("Enter");
    assert.equal(await editPage.locator("#chainId").inputValue(), "hut-left");
    assert.equal((await draft()).library.tiles[0].weight, 2);

    // Exact slot coordinates: Tab walks dx → dy and the blueprint follows.
    await editPage.locator("#chainSection").selectOption("setPieces");
    await editPage.locator("#chainSlotX0").fill("2");
    await editPage.keyboard.press("Tab");
    assert.equal(await focusedId(), "chainSlotY0");
    await editPage.keyboard.type("1");
    await editPage.keyboard.press("Tab");
    assert.equal(await focusedId(), "chainSlotSet0");
    snap = await draft();
    assert.deepEqual([snap.library.setPieces[0].tiles[0].dx, snap.library.setPieces[0].tiles[0].dy], [2, 1]);
    assert.equal(await editPage.locator('#setPieceGrid [data-dx="2"][data-dy="1"].filled').count(), 1);
    assert.equal(await editPage.locator("#setPieceGrid .filled").count(), 1);

    // Changing the selection rebuilds the editor, and the draft survives a reload.
    await editPage.locator("#chainSection").selectOption("tiles");
    await editPage.locator('#tileGallery .tile-card[data-tile="half-hut-1"]').click();
    assert.equal(await editPage.locator("#chainId").inputValue(), "half-hut-1");
    assert.equal(await editPage.locator("#chainLabels").inputValue(), "");
    const before = (await draft()).library;
    await editPage.reload({ waitUntil: "domcontentloaded" });
    await editPage.waitForFunction(() => !!(window as any).chainLab);
    assert.deepEqual((await draft()).library, before, "edits are saved as they are made");
    await editPage.close();
  }

  // Saved Chain Library drafts may be unfinished, but the editor must never render a broken
  // container. Each persistence case gets its own browser context and localStorage.
  const draftKey = "last-exit-chain-library-v3";
  const starterPage = await browser.newPage();
  starterPage.on("pageerror", (error: Error) => errors.push(error.message));
  await starterPage.goto(base, { waitUntil: "domcontentloaded" });
  await starterPage.waitForFunction(() => !!(window as any).chainLab);
  const starterDraft = await starterPage.evaluate(() => (window as any).chainLab.snapshot().library);
  assert.equal(await starterPage.evaluate((key: string) => localStorage.getItem(key), draftKey), null,
    "opening a fresh editor does not save its starter draft");
  await starterPage.close();
  const savedDraftPage = async (raw: string, failBackup = false) => {
    const draftPage = await browser.newPage();
    draftPage.on("pageerror", (error: Error) => errors.push(error.message));
    await draftPage.addInitScript(({ key, source, fail }: { key: string; source: string; fail: boolean }) => {
      if (!sessionStorage.getItem("browser-draft-seeded")) {
        localStorage.setItem(key, source);
        sessionStorage.setItem("browser-draft-seeded", "yes");
      }
      if (fail) {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name: string, value: string) {
          if (name.startsWith(`${key}:rejected:`)) throw new DOMException("backup unavailable", "QuotaExceededError");
          return setItem.call(this, name, value);
        };
      }
    }, { key: draftKey, source: raw, fail: failBackup });
    await draftPage.goto(base, { waitUntil: "domcontentloaded" });
    await draftPage.waitForFunction(() => !!(window as any).chainLab);
    return draftPage;
  };
  const storedDraft = (draftPage: any) => draftPage.evaluate((key: string) => localStorage.getItem(key), draftKey);
  const rejectedBackups = (draftPage: any) => draftPage.evaluate((key: string) =>
    Object.keys(localStorage).filter((entry) => entry.startsWith(`${key}:rejected:`))
      .map((entry) => ({ key: entry, raw: localStorage.getItem(entry) })), draftKey);

  const validSaved = structuredClone(starterDraft);
  validSaved.name = "valid-saved-browser-draft";
  const validRaw = JSON.stringify(validSaved);
  const validPage = await savedDraftPage(validRaw);
  assert.deepEqual(await validPage.evaluate(() => (window as any).chainLab.snapshot().library), validSaved);
  assert.equal(await storedDraft(validPage), validRaw);
  await validPage.reload({ waitUntil: "domcontentloaded" });
  await validPage.waitForFunction(() => !!(window as any).chainLab);
  assert.deepEqual(await validPage.evaluate(() => (window as any).chainLab.snapshot().library), validSaved,
    "a complete saved library reloads unchanged");
  assert.equal(await storedDraft(validPage), validRaw);
  await validPage.close();

  const incomplete = structuredClone(starterDraft);
  incomplete.name = "unfinished-browser-draft";
  incomplete.authoringNote = { unrecognized: ["keep", 17] };
  incomplete.tiles[0].orientations = [];
  incomplete.tiles[0].defaultCellClass = "missing-class";
  incomplete.tileSets[0].members = [];
  incomplete.setPieces[0].tiles = [];
  incomplete.setPieces[0].primaryRegionClass = "missing-class";
  incomplete.setPieceClasses[0].setPieces = [];
  incomplete.setPieceClasses[0].quota = -1;
  incomplete.tiles.push({ id: "missing-references", defaultCellClass: "open", orientations: [0] });
  incomplete.tileSets.push({ id: "unresolved-members", members: ["absent-tile"] });
  incomplete.setPieces.push({ id: "unresolved-slot", tiles: [{ dx: 0, dy: 0, tileSetId: "absent-set" }] });
  incomplete.setPieces.push({ id: "huge-slot", tiles: [{ dx: 1000000, dy: -1000000, tileSetId: "one" }] });
  incomplete.setPieceClasses.push({ id: "unresolved-piece", placementRule: "small", quota: 1, setPieces: ["absent-piece"] });
  const incompleteRaw = JSON.stringify(incomplete);
  const incompletePage = await savedDraftPage(incompleteRaw);
  assert.deepEqual(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library), incomplete,
    "structurally safe, invalid authoring work loads without normalization");
  assert.equal(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().valid), false);
  await incompletePage.locator("#chainTab").click();
  await incompletePage.locator("#chainExport").click();
  assert.match(await incompletePage.locator("#chainStatus").innerText(), /Export refused/);
  for (const section of ["classes", "tiles", "tileSets", "setPieces", "setPieceClasses"]) {
    await incompletePage.locator("#chainSection").selectOption(section);
    assert.equal(await incompletePage.locator("#chainEditor").isVisible(), true, `${section} remains navigable`);
  }
  await incompletePage.locator("#chainSection").selectOption("tiles");
  await incompletePage.locator("#tileFilter").fill("missing-references");
  assert.equal(await incompletePage.locator('#tileGallery .tile-card[data-tile="missing-references"]').isVisible(), true);
  await incompletePage.locator("#tileFilter").fill("");
  await incompletePage.locator("#chainSection").selectOption("setPieces");
  await incompletePage.locator('#chainEntryList button[data-entry="huge-slot"]').click();
  assert.match(await incompletePage.locator("#chainEditor").innerText(), /Blueprint preview is too large/);
  assert.deepEqual(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library), incomplete,
    "navigation and filtering do not edit the draft");
  assert.equal(await storedDraft(incompletePage), incompleteRaw);
  await incompletePage.reload({ waitUntil: "domcontentloaded" });
  await incompletePage.waitForFunction(() => !!(window as any).chainLab);
  assert.deepEqual(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library), incomplete,
    "an incomplete draft survives reload unchanged");
  assert.equal(await storedDraft(incompletePage), incompleteRaw);
  await incompletePage.locator("#chainTab").click();
  await incompletePage.locator("#chainViewContainer details summary").click();
  const failedSource = JSON.stringify({ ...incomplete, version: 2 }, null, 2);
  await incompletePage.locator("#chainSource").fill(failedSource);
  await incompletePage.locator("#chainApply").click();
  assert.match(await incompletePage.locator("#chainStatus").innerText(), /Import refused/);
  assert.equal(await incompletePage.locator("#chainSource").inputValue(), failedSource,
    "rejected Apply JSON source remains available for correction");
  assert.deepEqual(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library), incomplete);
  assert.equal(await storedDraft(incompletePage), incompleteRaw);
  await incompletePage.locator("#chainSection").selectOption("classes");
  await incompletePage.locator("#chainImport").setInputFiles({
    name: "invalid-draft.json", mimeType: "application/json", buffer: Buffer.from(failedSource),
  });
  await incompletePage.waitForFunction(() => document.getElementById("chainStatus")?.textContent?.includes("Import refused"));
  assert.deepEqual(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library), incomplete);
  assert.equal(await storedDraft(incompletePage), incompleteRaw);
  await incompletePage.locator("#chainAdd").click();
  const editedIncomplete = await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library);
  assert.equal(editedIncomplete.authoringNote.unrecognized[0], "keep", "an edit preserves unknown source fields");
  assert.equal(await storedDraft(incompletePage), JSON.stringify(editedIncomplete),
    "an incomplete but structurally safe draft autosaves after editing");
  await incompletePage.reload({ waitUntil: "domcontentloaded" });
  await incompletePage.waitForFunction(() => !!(window as any).chainLab);
  assert.deepEqual(await incompletePage.evaluate(() => (window as any).chainLab.snapshot().library), editedIncomplete,
    "edited incomplete work survives another reload");
  await incompletePage.close();

  const malformedSaved = [
    ["unsupported schema", JSON.stringify({ ...starterDraft, version: 2 })],
    ["invalid JSON", "{unfinished"],
    ["missing tiles", JSON.stringify({ ...starterDraft, tiles: null })],
    ["wrong orientations", JSON.stringify({ ...starterDraft, tiles: [{ ...starterDraft.tiles[0], orientations: "north" }] })],
    ["null segment", JSON.stringify({ ...starterDraft, tiles: [{ ...starterDraft.tiles[0], segments: { "v:3,2": null } }] })],
    ["malformed segment key", JSON.stringify({ ...starterDraft, tiles: [{ ...starterDraft.tiles[0], segments: { "oops": { passability: "any" } } }] })],
    ["null label", JSON.stringify({ ...starterDraft, tiles: [{ ...starterDraft.tiles[0], labels: [null] }] })],
    ["scalar legend", JSON.stringify({ ...starterDraft, tiles: [{ ...starterDraft.tiles[0], legend: "hut" }] })],
    ["numeric cell row", JSON.stringify({ ...starterDraft, tiles: [{ ...starterDraft.tiles[0], cells: [7] }] })],
    ["null slot", JSON.stringify({ ...starterDraft, setPieces: [{ ...starterDraft.setPieces[0], tiles: [null] }] })],
    ["wrong group members", JSON.stringify({ ...starterDraft, setPieceClasses: [{ ...starterDraft.setPieceClasses[0], setPieces: null }] })],
  ] as const;
  for (const [name, raw] of malformedSaved) {
    const rejectedPage = await savedDraftPage(raw);
    assert.deepEqual(await rejectedPage.evaluate(() => (window as any).chainLab.snapshot().library), starterDraft,
      `${name}: a broken saved container falls back to the starter`);
    assert.match(await rejectedPage.locator("#chainStatus").innerText(), /loaded the starter library/);
    assert.equal(await storedDraft(rejectedPage), raw, `${name}: load preserves the original value`);
    assert.deepEqual(await rejectedBackups(rejectedPage), [], `${name}: backup waits for an edit`);
    if (!["unsupported schema", "invalid JSON", "null segment"].includes(name)) {
      await rejectedPage.close();
      continue;
    }
    await rejectedPage.reload({ waitUntil: "domcontentloaded" });
    await rejectedPage.waitForFunction(() => !!(window as any).chainLab);
    assert.equal(await storedDraft(rejectedPage), raw, `${name}: reload also preserves the original`);
    await rejectedPage.locator("#chainTab").click();
    await rejectedPage.locator("#chainAdd").click();
    const backups = await rejectedBackups(rejectedPage);
    assert.equal(backups.length, 1, `${name}: first edit makes exactly one rejected-value backup`);
    assert.equal(backups[0]!.raw, raw, `${name}: backup contains the exact saved value`);
    assert.equal(await rejectedPage.locator("#chainStatus").innerText().then((status: string) => status.includes(backups[0]!.key)), true,
      `${name}: warning identifies the backup key`);
    assert.notEqual(await storedDraft(rejectedPage), raw, `${name}: edited starter is saved after backup`);
    await rejectedPage.locator("#chainAdd").click();
    assert.equal(await rejectedPage.locator("#chainStatus").innerText().then((status: string) => status.includes(backups[0]!.key)), false,
      `${name}: the next save clears the backup notice`);
    assert.equal((await rejectedBackups(rejectedPage)).length, 1, `${name}: later saves make no further backups`);
    await rejectedPage.close();
  }
  const failedBackupRaw = "{keep this raw draft";
  const failedBackupPage = await savedDraftPage(failedBackupRaw, true);
  await failedBackupPage.locator("#chainTab").click();
  await failedBackupPage.locator("#chainAdd").click();
  assert.equal(await storedDraft(failedBackupPage), failedBackupRaw,
    "when backup storage fails, autosave does not replace the rejected value");
  assert.deepEqual(await rejectedBackups(failedBackupPage), []);
  assert.match(await failedBackupPage.locator("#chainStatus").innerText(), /Draft not saved: the rejected original could not be backed up/);
  await failedBackupPage.close();
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
  await page.locator('#chainEntryList button[data-entry="open"]').click();
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

  // Author an uninterrupted block for building traces. The bundled block's internal
  // guarantees deliberately split its fill; it need not retain the former warehouse.
  const blockLibrary = structuredClone(CHAIN_LIBRARY);
  blockLibrary.tiles.push({ id: "block-browser-fixture", defaultCellClass: "block", orientations: [0], weight: 0, segments: {} });
  const blockFixture: typeof reference = { library: blockLibrary, cellSize: 40, build: GAME_ENGINES.version, results: [],
    layout: { seed: "block-browser-1", params: chainParams({ mode: "playground", zoneWidth: 4, zoneHeight: 4 }),
      library: libraryFingerprint(blockLibrary), setPieces: [], slots: Array.from({ length: 36 }, (_, i) =>
        ({ col: 7 + i % 6, row: 7 + Math.floor(i / 6), design: "block-browser-fixture", orientation: 0 })) } };
  blockFixture.results = mapViews(blockFixture).briefs.map(brief => GAME_ENGINES.build(brief));
  await drillPage.locator("#load").setInputFiles({ name: "block-traces.json", mimeType: "application/json",
    buffer: Buffer.from(chainMapToJson(blockFixture)) });
  await drillShown("block-browser-1");
  const blockBrief = mapViews(blockFixture).briefs[0]!;
  const blockDrill = await drillInto(blockBrief);
  assert.equal(blockDrill.drill.difference, null, "the block rebuilds equal to the stored result");
  assert.deepEqual(blockDrill.drill.lots.map((lot: { type: string }) => lot.type), planBlock(blockBrief).lots.map(lot => lot.type));
  assert.deepEqual(blockDrill.drill.buildings, [`${blockBrief.id}/lot-2/depot-warehouse-1`, `${blockBrief.id}/lot-4/compound`],
    "the depot and compound are traced, labelled as their lot's elements");
  assert.equal(blockDrill.drill.drawn.lots.lots, 5);
  assert.ok(blockDrill.drill.drawn.graph.nodes > 0);
  assert.match(blockDrill.inspector, /5 lots/);
  await drillPage.screenshot({ path: `${OUT}/drill-block.png` });
  await drillPage.close();

  // Routes (53 "Routes"): the game's route search for both bodies, measured in the worker on
  // request. A spawn to the exit on the default seed draws both, with the lengths the tools'
  // own measurement gives; the void outside the map's mask is plainly unreachable.
  const routePage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  routePage.on("pageerror", (error: Error) => errors.push(error.message));
  await routePage.goto(base, { waitUntil: "domcontentloaded" });
  await routePage.waitForFunction(() => (window as any).mapLab?.snapshot().seed === "last-exit-001" && !(window as any).mapLab.snapshot().busy, null, { timeout: 60000 });
  const measured = async () => {
    await routePage.locator("#measureRoutes").click();
    await routePage.waitForFunction(() => {
      const routes = (window as any).mapLab.snapshot().routes;
      return routes && !routes.pending;
    }, null, { timeout: 30000 });
    return (await routePage.evaluate(() => (window as any).mapLab.snapshot())).routes;
  };
  assert.deepEqual([await routePage.locator("#routeFrom").inputValue(), await routePage.locator("#routeTo").inputValue()], ["spawn 1", "exit 1"]);
  const routed = await measured();
  const sites = referenceViews.built.regions.flatMap((region) => region.coreElements);
  const expected = measureRoutes(referenceViews.built, sites.find((site) => site.kind === "spawn")!, sites.find((site) => site.kind === "exit")!);
  assert.equal(routed.error, "");
  for (const body of ["contestant", "hunter"] as const) {
    assert.ok(Math.abs(routed[body].length - expected[body].length!) < 1e-6, `the ${body}'s length is the core's`);
    assert.equal(routed[body].points, expected[body].points.length);
  }
  assert.equal(routed.squeezes, expected.squeezes.length);
  assert.deepEqual(routed.drawn, { contestant: expected.contestant.points.length, hunter: expected.hunter.points.length, squeezes: expected.squeezes.length }, "both routes are drawn");
  assert.match(routed.text, /Contestant \(clearance 14\): [\d,]+ world units on the grid/);
  assert.match(routed.text, /Hunter \/ contestant: \d\.\d{3}/);
  await routePage.screenshot({ path: `${OUT}/routes.png` });
  await routePage.evaluate(() => (window as any).mapLab.select(0, 0));
  await routePage.locator("#routeTo").selectOption("selected");
  const lost = await measured();
  assert.deepEqual([lost.contestant.length, lost.hunter.length, lost.ratio], [null, null, null]);
  assert.match(lost.text, /Contestant \(clearance 14\): no route/);
  assert.match(lost.text, /Hunter \(clearance 25\): no route/);
  await routePage.close();

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
  assert.ok(
    await linkPage
      .locator(`#tileGallery .tile-card[data-tile="${design}"]`)
      .evaluate((el: HTMLElement) => el.classList.contains("active")),
    "tile gallery reflects active card when opened from world view shortcut",
  );
  await linkPage.close();

  // Play in the game (53): the default recipe isn't a room's, and the lab says why. With a
  // room's recipe and an integer seed it links to a new room on the game's server, which
  // plays the same map: the same frame and every site where the lab's built view puts it.
  const playPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  playPage.on("pageerror", (error: Error) => errors.push(error.message));
  await playPage.goto(base, { waitUntil: "domcontentloaded" });
  await playPage.waitForFunction(() => (window as any).mapLab?.snapshot().seed === "last-exit-001" && !(window as any).mapLab.snapshot().busy, null, { timeout: 60000 });
  const notLive = (await playPage.evaluate(() => (window as any).mapLab.snapshot())).play;
  assert.equal(notLive.href, null);
  assert.match(notLive.note, /isn't a room seed/);
  assert.match(notLive.note, /exitCount is 2; a room uses 1/);
  await playPage.locator("#seed").fill("4217");
  await openActionMenu(playPage, "roomRecipe");
  await playPage.locator("#roomRecipe").click();
  await playPage.waitForFunction(() => {
    const lab = (window as any).mapLab.snapshot();
    return lab.seed === "4217" && !lab.busy && lab.play.href;
  }, null, { timeout: 60000 });
  const playable = await playPage.evaluate(() => (window as any).mapLab.snapshot());
  assert.equal(playable.error, "");
  assert.equal(playable.play.href, `${gameUrl}/?seed=4217&size=12x6`);
  const opening = playPage.context().waitForEvent("page");
  await openActionMenu(playPage, "playInGame");
  await playPage.locator("#playInGame").click();
  const room = await opening;
  room.on("pageerror", (error: Error) => errors.push(`game: ${error.message}`));
  const played = await matchMap(room, 4217, 60000);
  const at = (kind: string) => playable.world.sites.filter((site: { kind: string }) => site.kind === kind).map(({ x, y }: { x: number; y: number }) => ({ x, y }));
  const byPosition = (points: { x: number; y: number }[]) => [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  assert.equal(played.seed, 4217);
  assert.deepEqual([played.width, played.height], [playable.world.width, playable.world.height]);
  assert.deepEqual(played.spawns, at("spawn"));
  assert.deepEqual(played.hunterSpawns, at("hunter-spawn"));
  assert.deepEqual([played.exit], at("exit"));
  assert.deepEqual(byPosition(played.stations), byPosition(at("warp")));
  assert.deepEqual(byPosition(played.chargers), byPosition(at("charger")));
  // A room's map doesn't keep regions; its playable mask is every region's cells, so the
  // regions match when the masks do.
  assert.deepEqual(played.playableArea, playable.world.playableArea);
  assert.equal(playable.builtRegions, generate("4217", liveChainParams()).results.length);
  await room.screenshot({ path: `${OUT}/play-room.png` });
  await room.close();
  // A larger authored size is a room's too, and the link carries it: the room opens at the size
  // the lab shows, not the form's default.
  await playPage.locator("#zoneSize").selectOption("24x12");
  await playPage.locator("#generate").click();
  await playPage.waitForFunction(() => {
    const lab = (window as any).mapLab.snapshot();
    return lab.seed === "4217" && !lab.busy && lab.play.href?.endsWith("&size=24x12");
  }, null, { timeout: 120000 });
  const bigMap = await playPage.evaluate(() => (window as any).mapLab.snapshot());
  assert.equal(bigMap.play.href, `${gameUrl}/?seed=4217&size=24x12`);
  const openingBig = playPage.context().waitForEvent("page");
  await openActionMenu(playPage, "playInGame");
  await playPage.locator("#playInGame").click();
  const bigRoom = await openingBig;
  bigRoom.on("pageerror", (error: Error) => errors.push(`game: ${error.message}`));
  const bigPlayed = await matchMap(bigRoom, 4217, 120000);
  assert.deepEqual([bigPlayed.width, bigPlayed.height], [bigMap.world.width, bigMap.world.height]);
  assert.deepEqual(bigPlayed.spawns, bigMap.world.sites.filter((site: { kind: string }) => site.kind === "spawn").map(({ x, y }: { x: number; y: number }) => ({ x, y })));
  assert.deepEqual(bigPlayed.playableArea, bigMap.world.playableArea);
  await bigRoom.close();
  await playPage.locator("#zoneSize").selectOption("12x6");
  await playPage.locator("#generate").click();
  await playPage.waitForFunction(() => {
    const lab = (window as any).mapLab.snapshot();
    return lab.seed === "4217" && !lab.busy && lab.play.href?.endsWith("&size=12x6");
  }, null, { timeout: 60000 });
  // A save keeps its seed and recipe when its layout is edited, but a room with that seed
  // would generate the original, so the lab compares a loaded map with its seed's.
  const turned = generate("4217", liveChainParams()), slot = turned.layout.slots[0]!;
  slot.orientation = slot.orientation === 0 ? 90 : 0;
  await writeFile(`${OUT}/edited-layout.json`, chainMapToJson(turned, { results: false }));
  await playPage.locator("#load").setInputFiles(`${OUT}/edited-layout.json`);
  await playPage.waitForFunction(() => {
    const lab = (window as any).mapLab.snapshot();
    return !lab.busy && /its seed generates/.test(lab.play.note);
  }, null, { timeout: 60000 });
  const edited = (await playPage.evaluate(() => (window as any).mapLab.snapshot())).play;
  assert.equal(edited.href, null);
  assert.match(edited.note, /layout\.slots\[0\]\.orientation/);
  await playPage.close();

  // The Placeables tab (#433, 20.8): every registered placeable, each example previewed, and
  // parameters edited within their specs, with errors and refusals shown in place of a preview.
  const placeablesPage = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const placeableErrors: string[] = [];
  placeablesPage.on("pageerror", (e: Error) => placeableErrors.push(e.message));
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

  await page.setViewportSize({ width: 560, height: 900 });
  await page.locator("#librarySource").selectOption("bundled");
  await generateIn("lab-mobile");
  await page.screenshot({ path: `${OUT}/mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Map Lab browser checks passed: chain maps and their layers, saves equal to the core's, read-back, the diagnostic, drill-down, routes, playing a map in the game, chain library authoring, and placeables.");
} finally {
  await browser?.close();
  await game.close();
  await rm(replayDir, { recursive: true, force: true });
}
