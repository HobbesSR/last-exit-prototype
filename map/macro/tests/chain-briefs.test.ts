/**
 * 51 step 7: Briefs. The fixture's briefs hold to the harnesses and to the contract's
 * shape, and each names only its own region: its cells, the zones they lie in, its class
 * rule, and the portals on its own perimeter. Small hand-placed layouts pin the
 * translation into global cells, the zone split, and the resolved core element counts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CORE_ELEMENT_KINDS } from "../../kernel/contract.ts";
import type { Cell, RegionBrief } from "../../kernel/contract.ts";
import { briefs, chainZones } from "../src/chain/briefs.ts";
import type { ChainLibrary, ChainTileDesign } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import { regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Layout, LayoutRegions, PlacedSlot } from "../src/chain/types.ts";
import { assertDeterministic, assertPure, assertRecomputable } from "./chain-harness.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, lootChance: 0.04, lootTierStep: 0.09 };
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];
const CELL_SIZE = 4;
const layouts = new Map(SEEDS.map((seed) => [seed, placement(seed, GAME, LIBRARY)]));
const derive = (layout: Layout, library: ChainLibrary): LayoutRegions => regions(resolution(layout, library), layout.seed);
const brief = (layout: Layout, library: ChainLibrary, cellSize: number): RegionBrief[] =>
  briefs(layout, derive(layout, library), chainZones(layout.params), library, cellSize);
const key = (cell: Cell): string => `${cell.x},${cell.y}`;

/**
 * The contract's shape, as `briefErrors` in `map/micro/region-types.ts` checks it. Macro
 * and micro don't import each other (50), so the rule is copied here, plus what that
 * check leaves to the builder: every portal lies on the brief's perimeter, with its cells
 * on exactly one side of every segment.
 */
function contractErrors(brief: RegionBrief): string[] {
  const errors: string[] = [];
  if (!brief.id || !Number.isSafeInteger(brief.seed)) errors.push("id and integer seed");
  if (!brief.type) errors.push("region type");
  if (!(brief.cellSize > 0)) errors.push("cell size");
  if (!brief.cells.length) return [...errors, "cells"];
  const cells = new Set(brief.cells.map(key)), zoned = new Set<string>();
  for (const zone of brief.zones) {
    if (!Number.isInteger(zone.tier) || zone.tier < 1 || zone.tier > 5 || !Number.isInteger(zone.bonus) || zone.bonus < 0
      || !(zone.lootChance >= 0 && zone.lootChance <= 1)) errors.push(`zone ${zone.tier}/${zone.bonus}`);
    for (const cell of zone.cells) {
      if (!cells.has(key(cell)) || zoned.has(key(cell))) errors.push(`zone cell ${key(cell)}`);
      zoned.add(key(cell));
    }
  }
  if (zoned.size !== cells.size) errors.push("every cell in one zone");
  for (const [kind, count] of Object.entries(brief.coreElements ?? {}))
    if (!CORE_ELEMENT_KINDS.includes(kind as never) || !Number.isInteger(count) || count! < 0) errors.push(`core element ${kind}`);
  for (const portal of brief.portals) for (let i = 0; i < portal.length; i++) {
    const [lower, upper] = portal.axis === "h"
      ? [`${portal.x + i},${portal.y - 1}`, `${portal.x + i},${portal.y}`]
      : [`${portal.x - 1},${portal.y + i}`, `${portal.x},${portal.y + i}`];
    if (cells.has(lower) === cells.has(upper)) errors.push(`portal ${portal.id} segment ${i} isn't on the perimeter`);
  }
  return errors;
}

test("briefs are pure, deterministic and recomputable from the Layout", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const found = derive(layout, LIBRARY), zones = chainZones(layout.params);
  const list = assertPure("briefs", briefs, layout, found, zones, LIBRARY, CELL_SIZE);
  assert.deepEqual(assertDeterministic("briefs", briefs, layout, found, zones, LIBRARY, CELL_SIZE), list);
  assertRecomputable("briefs", list, brief, layout, LIBRARY, CELL_SIZE);
});

test("the fixture's briefs meet the contract, one per region, covering the map once", () => {
  for (const [seed, layout] of layouts) {
    const found = derive(layout, LIBRARY);
    const list = briefs(layout, found, chainZones(layout.params), LIBRARY, CELL_SIZE);
    assert.deepEqual(list.map((b) => b.id), found.regions.map((r) => r.id), seed);
    for (const b of list) assert.deepEqual(contractErrors(b), [], `${seed} ${b.id}`);
    // Every cell of the mask is in exactly one brief.
    const all = list.flatMap((b) => b.cells.map(key));
    assert.equal(new Set(all).size, all.length, seed);
    assert.equal(all.length, found.regions.reduce((n, r) => n + r.cells.length, 0), seed);
    // Every portal is in the briefs of exactly the two regions it lies between, and in no other.
    for (const portal of found.portals) {
      const holders = list.filter((b) => b.portals.some((p) => p.id === portal.id)).map((b) => b.id);
      assert.deepEqual(holders.sort(), [portal.a, portal.b].sort(), `${seed} ${portal.id}`);
    }
  }
});

test("a brief names only its own region: its cells, its class rule, its zones and its portals", () => {
  const layout = layouts.get(SEEDS[1]!)!;
  const found = derive(layout, LIBRARY);
  const list = briefs(layout, found, chainZones(layout.params), LIBRARY, CELL_SIZE);
  const width = 5 * GAME.zoneWidth * 6;
  for (const [i, region] of found.regions.entries()) {
    const b = list[i]!;
    assert.deepEqual(b.cells.map((c) => c.y * width + c.x), region.cells);
    assert.equal(b.seed, region.seed);
    assert.equal(b.type, LIBRARY.cellClasses[region.class]!.regionType);
    assert.equal(b.cellSize, CELL_SIZE);
    // A portal carries its run and id, and not the regions on each side.
    for (const portal of b.portals) assert.deepEqual(Object.keys(portal).sort(), ["axis", "id", "length", "x", "y"]);
  }
  // Core element counts are resolved; exitCount comes from the params.
  const departure = list.find((b) => b.type === "departure")!;
  assert.deepEqual(departure.coreElements, { exit: GAME.exitCount, "hunter-spawn": 1 });
  assert.deepEqual(list.find((b) => b.type === "arrival")!.coreElements, { spawn: 1 });
  assert.equal(list.find((b) => b.type === "open-field")!.coreElements, undefined);
});

// ── Hand-placed layouts ─────────────────────────────────────────────────────

const column = (mark: string) => Array.from({ length: 6 }, () => `.....${mark}`);
const passable = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { passability: "passable" as const }]));
const HAND_TILES: ChainTileDesign[] = [
  { id: "field", defaultCellClass: "open", orientations: [0] },
  { id: "hut-west", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0],
    segments: passable("v:5,2", "v:5,3") },
  { id: "departure-west", defaultCellClass: "open", cells: column("d"), legend: { d: "departure" }, orientations: [0],
    segments: passable("v:5,2", "v:5,3") },
];
const HAND: ChainLibrary = {
  ...LIBRARY,
  tiles: HAND_TILES,
  cellClasses: { ...LIBRARY.cellClasses, hut: { regionType: "hut", params: { doors: 2, style: "tin", lit: true } } },
};
/** Playground, with one-tile zones, so neighbouring slots lie in different tiers. */
const PLAYGROUND: ChainParams = { ...GAME, mode: "playground", zoneWidth: 1, zoneHeight: 1, exitCount: 3 };

function hand(slots: Record<string, string>): { found: LayoutRegions; list: RegionBrief[] } {
  const placed: PlacedSlot[] = Object.entries(slots).map(([at, design]) => {
    const [col, row] = at.split(",").map(Number) as [number, number];
    return { col, row, design, orientation: 0 };
  });
  const layout: Layout = { seed: "hand", params: PLAYGROUND, library: "hand", slots: placed, setPieces: [] };
  const found = derive(layout, HAND);
  return { found, list: briefs(layout, found, chainZones(PLAYGROUND), HAND, 2.5) };
}

test("a hand-placed brief has global cells, its class rule's parameters, and the portal on its edge", () => {
  // Slot 1,1 covers cells 6..11 by 6..11; its hut column is x = 11.
  const { list } = hand({ "1,1": "hut-west" });
  const hut = list.find((b) => b.id === "hut@11,6")!;
  assert.deepEqual(hut.cells, [6, 7, 8, 9, 10, 11].map((y) => ({ x: 11, y })));
  assert.deepEqual(hut.parameters, { doors: 2, style: "tin", lit: true });
  assert.equal(hut.cellSize, 2.5);
  assert.deepEqual(hut.portals, [{ id: "hut@11,6~open@6,6~v:11,8", axis: "v", x: 11, y: 8, length: 2 }]);
  // The open side holds the same portal, so both briefs name it alike.
  assert.deepEqual(list.find((b) => b.id === "open@6,6")!.portals, hut.portals);
  // Zone 1,1 is tier 2, bonus 1 in the five-by-five zone grid.
  assert.deepEqual(hut.zones.map(({ tier, bonus, lootChance }) => ({ tier, bonus, lootChance })),
    [{ tier: 2, bonus: 1, lootChance: GAME.lootChance + GAME.lootTierStep }]);
  assert.deepEqual(list.map(contractErrors), [[], []]);
});

test("a region across zones gets one zone context per zone, and a region with no portal lists none", () => {
  // Two fields side by side form one open region across two tiers; the departure column
  // beyond them has its portal on its west face, so the field region holds it too.
  const { list } = hand({ "1,2": "field", "2,2": "departure-west" });
  const open = list.find((b) => b.id === "open@6,12")!;
  assert.deepEqual(open.zones.map((z) => [z.tier, z.cells.length]), [[2, 36], [3, 30]]);
  assert.equal(open.zones.flatMap((z) => z.cells).length, open.cells.length);
  const departure = list.find((b) => b.type === "departure")!;
  assert.deepEqual(departure.coreElements, { exit: 3, "hunter-spawn": 1 });
  assert.equal(departure.portals.length, 1);
  const shut = hand({ "1,1": "field" }).list;
  assert.deepEqual(shut.map((b) => b.portals), [[]]);
});

test("briefs refuse a class the library doesn't register, and a cell size that isn't positive", () => {
  const layout: Layout = { seed: "hand", params: PLAYGROUND, library: "hand",
    slots: [{ col: 1, row: 1, design: "hut-west", orientation: 0 }], setPieces: [] };
  const found = derive(layout, HAND);
  const { hut: _, ...rest } = HAND.cellClasses;
  assert.throws(() => briefs(layout, found, chainZones(PLAYGROUND), { ...HAND, cellClasses: rest }, 1), /class hut/);
  assert.throws(() => briefs(layout, found, chainZones(PLAYGROUND), HAND, 0), /cell size/);
});

test("exitCount resolves with no ceiling, and must be a whole number", () => {
  const at = (exitCount: number): Layout => ({ seed: "hand", params: { ...PLAYGROUND, exitCount }, library: "hand",
    slots: [{ col: 1, row: 1, design: "departure-west", orientation: 0 }], setPieces: [] });
  const many = at(1000);
  const departure = briefs(many, derive(many, HAND), chainZones(many.params), HAND, 1).find((b) => b.type === "departure")!;
  assert.deepEqual(departure.coreElements, { exit: 1000, "hunter-spawn": 1 });
  assert.deepEqual(contractErrors(departure), []);
  for (const bad of [2.5, -1]) {
    const layout = at(bad);
    assert.throws(() => briefs(layout, derive(layout, HAND), chainZones(layout.params), HAND, 1), /exitCount must be a whole number/);
    assert.throws(() => placement("bad", { ...GAME, exitCount: bad }, LIBRARY), /exitCount must be a whole number/);
  }
});
