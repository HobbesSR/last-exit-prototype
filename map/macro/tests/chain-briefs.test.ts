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
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];
const CELL_SIZE = 4;
const layouts = new Map(SEEDS.map((seed) => [seed, placement(seed, GAME, LIBRARY)]));
const derive = (layout: Layout, library: ChainLibrary): LayoutRegions => regions(resolution(layout, library), layout.seed);
const brief = (layout: Layout, library: ChainLibrary, cellSize: number): RegionBrief[] =>
  briefs(layout, resolution(layout, library), derive(layout, library), chainZones(layout.params), library, cellSize);
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
  if (!(Number.isInteger(brief.cellSize) && brief.cellSize > 0)) errors.push("cell size");
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
  const found = derive(layout, LIBRARY), resolved = resolution(layout, LIBRARY), zones = chainZones(layout.params);
  const list = assertPure("briefs", briefs, layout, resolved, found, zones, LIBRARY, CELL_SIZE);
  assert.deepEqual(assertDeterministic("briefs", briefs, layout, resolved, found, zones, LIBRARY, CELL_SIZE), list);
  assertRecomputable("briefs", list, brief, layout, LIBRARY, CELL_SIZE);
});

test("the fixture's briefs meet the contract, one per region, covering the map once", () => {
  for (const [seed, layout] of layouts) {
    const found = derive(layout, LIBRARY);
    const list = briefs(layout, resolution(layout, LIBRARY), found, chainZones(layout.params), LIBRARY, CELL_SIZE);
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
  const list = briefs(layout, resolution(layout, LIBRARY), found, chainZones(layout.params), LIBRARY, CELL_SIZE);
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
  // Core element counts are resolved; exitCount and contestantCount come from the params.
  const departure = list.find((b) => b.type === "departure")!;
  assert.deepEqual(departure.coreElements, { exit: GAME.exitCount, "hunter-spawn": GAME.hunterCount });
  // A spawn is one contestant's spawn point (17 M20).
  assert.deepEqual(list.find((b) => b.type === "arrival")!.coreElements, { spawn: GAME.contestantCount });
  assert.equal(list.find((b) => b.type === "open-field")!.coreElements, undefined);
});

// ── Hand-placed layouts ─────────────────────────────────────────────────────

const column = (mark: string) => Array.from({ length: 6 }, () => `.....${mark}`);
const passable = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { passability: "passable" as const }]));
const hinted = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, { passability: "not-passable-hint" as const }]));
const HAND_TILES: ChainTileDesign[] = [
  // The hut column's west face is hinted, except for a doorway that is passable.
  { id: "hut-hinted", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0],
    segments: { ...hinted("v:5,0", "v:5,1", "v:5,4", "v:5,5"), ...passable("v:5,2", "v:5,3") } },
  // A hut column on the tile's west edge, hinted all along it.
  { id: "hut-edge", defaultCellClass: "open", cells: Array.from({ length: 6 }, () => "h....."), legend: { h: "hut" },
    orientations: [0], segments: hinted(...[0, 1, 2, 3, 4, 5].map((y) => `v:0,${y}`)) },
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
  return { found, list: briefs(layout, resolution(layout, HAND), found, chainZones(PLAYGROUND), HAND, 3) };
}

test("a hand-placed brief has global cells, its class rule's parameters, and the portal on its edge", () => {
  // Slot 1,1 covers cells 6..11 by 6..11; its hut column is x = 11.
  const { list } = hand({ "1,1": "hut-west" });
  const hut = list.find((b) => b.id === "hut@11,6")!;
  assert.deepEqual(hut.cells, [6, 7, 8, 9, 10, 11].map((y) => ({ x: 11, y })));
  assert.deepEqual(hut.parameters, { doors: 2, style: "tin", lit: true });
  assert.equal(hut.cellSize, 3);
  assert.deepEqual(hut.portals, [{ id: "hut@11,6~open@6,6~v:11,8", axis: "v", x: 11, y: 8, length: 2 }]);
  // The open side holds the same portal, so both briefs name it alike.
  assert.deepEqual(list.find((b) => b.id === "open@6,6")!.portals, hut.portals);
  // Zone 1,1 is tier 2, bonus 1 in the five-by-five zone grid.
  assert.deepEqual(hut.zones.map(({ tier, bonus, lootChance }) => ({ tier, bonus, lootChance })),
    [{ tier: 2, bonus: 1, lootChance: GAME.lootChance + GAME.lootTierStep }]);
  assert.deepEqual(list.map(contractErrors), [[], []]);
});

test("hinted perimeter stretches reach both briefs as maximal runs, apart from the portal", () => {
  const { list } = hand({ "1,1": "hut-hinted" });
  const hut = list.find((b) => b.id === "hut@11,6")!, open = list.find((b) => b.id === "open@6,6")!;
  const runs = [{ axis: "v", x: 11, y: 6, length: 2 }, { axis: "v", x: 11, y: 10, length: 2 }];
  assert.deepEqual(hut.hints, runs);
  assert.deepEqual(open.hints, runs);
  assert.deepEqual(hut.portals.map(({ id: _, ...run }) => run), [{ axis: "v", x: 11, y: 8, length: 2 }]);
  assert.deepEqual(list.map(contractErrors), [[], []]);
  // Unhinted libraries leave the field off, so their briefs keep their shape.
  assert.equal(hand({ "1,1": "hut-west" }).list.every((b) => b.hints === undefined), true);
});

test("a hint facing no region, here an unplaced slot, is one run, and is not a portal", () => {
  const { list } = hand({ "1,1": "hut-edge" });
  const hut = list.find((b) => b.type === "hut")!;
  assert.deepEqual(hut.hints, [{ axis: "v", x: 6, y: 6, length: 6 }]);
  assert.deepEqual(hut.portals, []);
});

test("a hint is split where a concave region passes to the other side of its line", () => {
  // A 4 × 4 block of hut slots at columns and rows 4 to 7, with (6,5) and (5,6) absent, is one region.
  // Slot (5,5) hints its east face and (6,6) its west face; both lie on cell line x = 36, with the
  // region west of the first six segments and east of the last six.
  const side = (id: string, key: string): ChainTileDesign =>
    ({ id, defaultCellClass: "hut", orientations: [0], segments: hinted(...[0, 1, 2, 3, 4, 5].map((i) => `v:${key},${i}`)) });
  const library: ChainLibrary = { ...HAND, tiles: [...HAND.tiles, { id: "hut-full", defaultCellClass: "hut", orientations: [0] },
    side("hint-east", "6"), side("hint-west", "0")] };
  const slots: PlacedSlot[] = [];
  for (let row = 4; row <= 7; row++) for (let col = 4; col <= 7; col++) {
    if ((col === 6 && row === 5) || (col === 5 && row === 6)) continue;
    slots.push({ col, row, design: col === 5 && row === 5 ? "hint-east" : col === 6 && row === 6 ? "hint-west" : "hut-full", orientation: 0 });
  }
  // Zones of 2 × 2 slots put the block in the occupied middle of the zone diamond.
  const params = { ...PLAYGROUND, zoneWidth: 2, zoneHeight: 2 };
  const layout: Layout = { seed: "hand", params, library: "hand", slots, setPieces: [] };
  const list = briefs(layout, resolution(layout, library), derive(layout, library), chainZones(params), library, 3);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0]!.hints, [{ axis: "v", x: 36, y: 30, length: 6 }, { axis: "v", x: 36, y: 36, length: 6 }]);
  assert.deepEqual(contractErrors(list[0]!), []);
});

test("a hint under a passable side is a portal, not a hint", () => {
  const library: ChainLibrary = { ...HAND, tiles: [...HAND.tiles, { id: "hut-both", defaultCellClass: "open", cells: column("h"),
    legend: { h: "hut" }, orientations: [0], segments: { "v:5,2": { passability: "passable" }, "v:5,3": { passability: "not-passable-hint" } } }] };
  const layout: Layout = { seed: "hand", params: PLAYGROUND, library: "hand",
    slots: [{ col: 1, row: 1, design: "hut-both", orientation: 0 }], setPieces: [] };
  const [first] = briefs(layout, resolution(layout, library), derive(layout, library), chainZones(PLAYGROUND), library, 3);
  assert.deepEqual(first!.portals.map(({ id: _, ...run }) => run), [{ axis: "v", x: 11, y: 8, length: 1 }]);
  assert.deepEqual(first!.hints, [{ axis: "v", x: 11, y: 9, length: 1 }]);
});

test("a region across zones gets one zone context per zone, and a region with no portal lists none", () => {
  // Two fields side by side form one open region across two tiers; the departure column
  // beyond them has its portal on its west face, so the field region holds it too.
  const { list } = hand({ "1,2": "field", "2,2": "departure-west" });
  const open = list.find((b) => b.id === "open@6,12")!;
  assert.deepEqual(open.zones.map((z) => [z.tier, z.cells.length]), [[2, 36], [3, 30]]);
  assert.equal(open.zones.flatMap((z) => z.cells).length, open.cells.length);
  const departure = list.find((b) => b.type === "departure")!;
  assert.deepEqual(departure.coreElements, { exit: 3, "hunter-spawn": PLAYGROUND.hunterCount });
  assert.equal(departure.portals.length, 1);
  const shut = hand({ "1,1": "field" }).list;
  assert.deepEqual(shut.map((b) => b.portals), [[]]);
});

test("briefs refuse a class the library doesn't register, and a cell size that isn't a positive whole number", () => {
  const layout: Layout = { seed: "hand", params: PLAYGROUND, library: "hand",
    slots: [{ col: 1, row: 1, design: "hut-west", orientation: 0 }], setPieces: [] };
  const found = derive(layout, HAND);
  const { hut: _, ...rest } = HAND.cellClasses;
  assert.throws(() => briefs(layout, resolution(layout, HAND), found, chainZones(PLAYGROUND), { ...HAND, cellClasses: rest }, 1), /class hut/);
  for (const bad of [0, -1, 2.5]) assert.throws(() => briefs(layout, resolution(layout, HAND), found, chainZones(PLAYGROUND), HAND, bad), /cell size/);
});

test("exitCount resolves with no ceiling, and must be a whole number", () => {
  const at = (exitCount: number): Layout => ({ seed: "hand", params: { ...PLAYGROUND, exitCount }, library: "hand",
    slots: [{ col: 1, row: 1, design: "departure-west", orientation: 0 }], setPieces: [] });
  const many = at(1000);
  const departure = briefs(many, resolution(many, HAND), derive(many, HAND), chainZones(many.params), HAND, 1).find((b) => b.type === "departure")!;
  assert.deepEqual(departure.coreElements, { exit: 1000, "hunter-spawn": PLAYGROUND.hunterCount });
  assert.deepEqual(contractErrors(departure), []);
  for (const bad of [2.5, -1]) {
    const layout = at(bad);
    assert.throws(() => briefs(layout, resolution(layout, HAND), derive(layout, HAND), chainZones(layout.params), HAND, 1), /exitCount must be a whole number/);
    assert.throws(() => placement("bad", { ...GAME, exitCount: bad }, LIBRARY), /exitCount must be a whole number/);
    assert.throws(() => placement("bad", { ...GAME, contestantCount: bad }, LIBRARY), /contestantCount must be a whole number/);
    assert.throws(() => placement("bad", { ...GAME, hunterCount: bad }, LIBRARY), /hunterCount must be a whole number/);
  }
});
