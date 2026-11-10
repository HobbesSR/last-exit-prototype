/**
 * The open-face rule (#113; 51 stage 1, 17 M2 and M11): placement refuses, during the
 * solve, any placement that seals a component or fixes a short portal. The fixture's
 * `hut-annex` gives it something to refuse: a hut column with no portal of its own,
 * which asks for hut across one edge, so it is reachable only where it merges with a
 * hut that has one. Small hand-built solves pin what each refusal is for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { declaredGrid, layoutViolations } from "../src/chain/declared-grid.ts";
import type { ChainLibrary, ChainTileDesign } from "../src/chain/library.ts";
import { LOOKAHEAD_SLOTS, openFaceRule } from "../src/chain/open-face.ts";
import { adjacencyCompatibility, adjacencyLinks, placement, placer } from "../src/chain/placement.ts";
import { proof, proofViolations } from "../src/chain/proof.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Layout } from "../src/chain/types.ts";
import { solveWfc } from "../src/wfc.ts";
import type { TileOption, WfcGrid } from "../src/wfc.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
// Seeds whose unruled layouts seal a hut (the draw is seeded, so the list is what it was found to be).
const SEEDS = ["open-face-1", "open-face-2", "open-face-4", "open-face-6"];

function violations(layout: Layout, library: ChainLibrary): string[] {
  const found = regions(resolution(layout, library), layout.seed);
  return [...layoutViolations(declaredGrid(layout, library)), ...portalViolations(found), ...proofViolations(proof(found), found, library)];
}

test("placed layouts pass the proof's gate and the portal rule", () => {
  for (const seed of SEEDS) assert.deepEqual(violations(placement(seed, GAME, LIBRARY), LIBRARY), [], seed);
});

test("with the rule switched off, the same seeds give layouts it refuses", () => {
  const unruled = placer({ openFace: false });
  for (const seed of SEEDS) {
    const found = violations(unruled(seed, GAME, LIBRARY), LIBRARY);
    assert.ok(found.some((v) => /no portal path/.test(v)), `${seed}: ${found.length} violations`);
  }
});

test("where nothing is refused, the rule changes no draw", () => {
  // Without the annex, the fixture's layouts already pass, so no branch is ever refused.
  const connected: ChainLibrary = { ...LIBRARY, tiles: LIBRARY.tiles.filter((tile) => tile.id !== "hut-annex") };
  const unruled = placer({ openFace: false });
  for (const seed of SEEDS.slice(0, 2)) assert.deepEqual(placement(seed, GAME, connected), unruled(seed, GAME, connected), seed);
});

// ── By hand ─────────────────────────────────────────────────────────────────

const column = (mark: string) => Array.from({ length: 6 }, () => `.....${mark}`);
const asksHut = Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [`v:6,${k}`, { adjacency: "hut" as const }]));
// The hut column's faces to open ground, sealed except on the given rows of its west face:
// an unstated face reads as `any`, which passes between two regions, so a hint states it sealed.
const hint = { passability: "not-passable-hint" as const };
const sealed = (...portals: number[]) => ({
  ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [`v:5,${k}`, portals.includes(k) ? { passability: "passable" as const } : hint])),
  "h:0,5": hint, "h:6,5": hint,
});
const HAND_TILES: ChainTileDesign[] = [
  { id: "field", defaultCellClass: "open", orientations: [0] },
  // A hut column that asks for hut across its east edge, without a portal, or with one
  // into its own open ground.
  { id: "annex", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, segments: { ...sealed(), ...asksHut }, orientations: [0, 180] },
  { id: "annex-door", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0, 180],
    segments: { ...sealed(2, 3), ...asksHut } },
  // A hut column whose west face is passable on its last row, or its first.
  { id: "door-foot", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0], segments: sealed(5) },
  { id: "door-head", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0], segments: sealed(0) },
  { id: "plain-column", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0], segments: sealed() },
];
const HAND: ChainLibrary = { ...LIBRARY, tiles: HAND_TILES, tileSets: [], setPieces: [], setPieceClasses: [] };

/** Solves slots `x,y` to their options (`design@orientation`), and returns each slot's design, or the refusals. */
function solve(slots: Record<string, string[]>, columns: number, rows: number): { placed: string[] | null; refusals: string[] } {
  const option = (text: string): TileOption => {
    const [templateId, orientation] = text.split("@") as [string, string | undefined];
    return { templateId, orientation: Number(orientation ?? 0) as 0, difficulty: 0, weight: 1 };
  };
  const grid: WfcGrid = Object.entries(slots).map(([at, options]) => {
    const [x, y] = at.split(",").map(Number) as [number, number];
    return { x, y, domain: options.map(option), links: [] };
  });
  adjacencyLinks(grid);
  const refusals: string[] = [];
  const solved = solveWfc(grid, adjacencyCompatibility(HAND), () => 0.5,
    { accept: openFaceRule(HAND, grid, columns, rows, (reason) => refusals.push(reason)) });
  return { placed: solved && solved.map((slot) => `${slot.domain[0]!.templateId}@${slot.domain[0]!.orientation}`), refusals };
}

test("a hut merged without a portal is sealed, and refused while another option remains", () => {
  // The annex's hut column meets its eastern neighbour's. Fields below join the open ground.
  const below = { "0,1": ["field"], "1,1": ["field"] };
  const sealed = solve({ "0,0": ["annex@0"], "1,0": ["annex@180"], ...below }, 2, 2);
  assert.equal(sealed.placed, null);
  // The hut and the open ground around it are each sealed from the other.
  assert.match(sealed.refusals[0]!, /^the component from (hut@5,0 \(12|open@0,0 \(132) cells\) has no portal path out$/);
  const rescued = solve({ "0,0": ["annex@0"], "1,0": ["annex@180", "annex-door@180"], ...below }, 2, 2);
  assert.deepEqual(rescued.placed, ["annex@0", "annex-door@180", "field@0", "field@0"]);
});

test("a component is refused as soon as no option left beside it could join it", () => {
  // The hut is closed below and at the sides. Every option left above it puts open
  // ground against it, so it is refused before either slot above is placed: the rule
  // doesn't wait for the last face to close.
  const early = solve({
    "0,0": ["field", "annex@180"], "1,0": ["field", "annex@0"],
    "0,1": ["annex@0"], "1,1": ["annex@180"], "0,2": ["field"], "1,2": ["field"],
  }, 2, 3);
  assert.equal(early.placed, null);
  assert.deepEqual(early.refusals, ["the component from hut@5,6 (12 cells) has no portal path out"]);
});

test("a sealed component is refused by its cut, not by every slot inside it", () => {
  // Three fields, then a hut column against the map's east edge. The open ground is checked
  // first and is sealed from the hut; only the slot holding the faces between them settles
  // that, so a solver backjumps there rather than to the latest field (#849: a sealed
  // map-sized component once named every slot, and placement backtracked one slot at a time).
  const grid: WfcGrid = ["field", "field", "field", "annex"].map((templateId, x) =>
    ({ x, y: 0, domain: [{ templateId, orientation: 0 as const, difficulty: 0, weight: 1 }], links: [] }));
  adjacencyLinks(grid);
  const refusals: string[] = [];
  const cause = openFaceRule(HAND, grid, 4, 1, (reason) => refusals.push(reason))(grid, [0, 1, 2, 3]);
  assert.deepEqual(refusals, ["the component from open@0,0 (138 cells) has no portal path out"]);
  assert.deepEqual(cause, [3]);
});

// A hut tile with no portal at all, for pockets the lookahead refuses (#857): every edge
// states a hint, so open ground beside it is not guaranteed to pass.
const HUT_BLOCK: ChainTileDesign = {
  id: "hut-block", defaultCellClass: "hut", orientations: [0, 180],
  segments: Object.fromEntries(["h:0", "h:6", "v:0", "v:6"].flatMap((line) =>
    [0, 1, 2, 3, 4, 5].map((k) => [`${line},${k}`, hint]))),
};
const POCKETS: ChainLibrary = { ...HAND, tiles: [...HAND_TILES, HUT_BLOCK] };
const one = (templateId: string, orientation: 0 | 180 = 0): TileOption => ({ templateId, orientation, difficulty: 0, weight: 1 });
const HUTS = [one("hut-block"), one("hut-block", 180)];

/** Checks the slots `x,y` (each fixed, or unplaced with several options) once, with the given lookahead. */
function checkOnce(slots: Record<string, TileOption[]>, columns: number, rows: number, lookahead?: number) {
  const grid: WfcGrid = Object.entries(slots).map(([at, domain]) => {
    const [x, y] = at.split(",").map(Number) as [number, number];
    return { x, y, domain, links: [] };
  });
  adjacencyLinks(grid);
  const placed = grid.flatMap((slot, i) => slot.domain.length === 1 ? [i] : []);
  const refusals: string[] = [];
  const cause = openFaceRule(POCKETS, grid, columns, rows, (reason) => refusals.push(reason), lookahead)(grid, placed);
  return { cause: cause === true ? cause : [...cause].sort(), refusals };
}

test("a pocket is refused while its hole is unplaced, once every side around it is closed (#857)", () => {
  // A hut, then a hole that can only be hut, then open ground, then a slot still to place.
  // The hut faces the hole, which could join it, so the rule's flood stops there; the open
  // ground faces the slot beyond it. But nothing the hole holds can join the open ground,
  // so the hut and the hole are sealed together already: the lookahead floods through the
  // hole and refuses them now, naming the slots that close it, not once the hole is placed.
  const check = (hole: TileOption[], lookahead?: number) =>
    checkOnce({ "0,0": [one("hut-block")], "1,0": hole, "2,0": [one("field")], "3,0": [one("field"), one("annex", 180)] }, 4, 1, lookahead);
  assert.deepEqual(check(HUTS), {
    cause: [0, 2], refusals: ["the area from hut@0,0 (72 cells, 1 unplaced slot) can't reach the rest of the map"],
  });
  // Without the lookahead it waits for the hole to be placed.
  assert.deepEqual(check(HUTS, 0), { cause: true, refusals: [] });
  // A hole that could still join the open ground is no pocket.
  assert.deepEqual(check([...HUTS, one("field")]), { cause: true, refusals: [] });
});

test("the lookahead's bounds limit its cost, not which areas can be refused (#857)", () => {
  // A hut, then `holes` slots that can only be hut, then open ground and `beyond` slots still
  // to place: the hut and its holes are sealed together, 36 cells a slot. The map is split, so
  // the open ground's side is sealed from the hut's too, and is refused where it is small.
  const row = (holes: number, lookahead?: number, beyond = 1) => {
    const slots: Record<string, TileOption[]> = { "0,0": [one("hut-block")] };
    for (let x = 1; x <= holes; x++) slots[`${x},0`] = HUTS;
    slots[`${holes + 1},0`] = [one("field")];
    for (let x = holes + 2; x <= holes + 1 + beyond; x++) slots[`${x},0`] = [one("field"), one("annex", 180)];
    return checkOnce(slots, holes + 2 + beyond, 1, lookahead).refusals;
  };
  // Within both bounds the pocket is refused, however large the cell budget.
  assert.deepEqual(row(8), ["the area from hut@0,0 (324 cells, 8 unplaced slots) can't reach the rest of the map"]);
  assert.deepEqual(row(1, 1e9), ["the area from hut@0,0 (72 cells, 1 unplaced slot) can't reach the rest of the map"]);
  assert.deepEqual(row(1, 72), ["the area from hut@0,0 (72 cells, 1 unplaced slot) can't reach the rest of the map"]);
  // Past either bound it is taken as open, and left to the open-face rule once it closes.
  assert.equal(LOOKAHEAD_SLOTS, 8);
  assert.deepEqual(row(9, undefined, 9), []);
  assert.deepEqual(row(9), ["the area from open@60,0 (72 cells, 1 unplaced slot) can't reach the rest of the map"]);
  assert.deepEqual(row(1, 71), []);
});

test("a pocket of unplaced slots alone is named as unsettled (#857)", () => {
  // A hole in the corner, between open ground that can still reach the slot beyond it.
  assert.deepEqual(checkOnce({
    "0,0": HUTS, "1,0": [one("field")], "0,1": [one("field")], "1,1": [one("field"), one("annex", 180)],
  }, 2, 2), {
    cause: [1, 2], refusals: ["the area from unsettled@0,0 (36 cells, 1 unplaced slot) can't reach the rest of the map"],
  });
});

test("a portal shorter than a hunter is refused once its ends are settled, and a seam can lengthen it", () => {
  // One passable segment at the foot of a column, continued, or not, by the column below.
  assert.deepEqual(solve({ "0,0": ["door-foot"], "0,1": ["plain-column", "door-head"] }, 1, 2).placed, ["door-foot@0", "door-head@0"]);
  const short = solve({ "0,0": ["door-foot"], "0,1": ["plain-column"] }, 1, 2);
  assert.equal(short.placed, null);
  assert.deepEqual(short.refusals, ["portal between open and hut at v:5,5 is 1 segment long, shorter than a hunter's 2"]);
});

// ── The solver's backjump ───────────────────────────────────────────────────

test("a refusal backjumps to the choice that caused it, past every later one", () => {
  // Unlinked cells of two options each collapse in order. The first cell's first option
  // is refused once the last cell is placed; chronological backtracking would try every
  // combination of the cells between before revisiting the first.
  const cells = 16;
  const options = () => ["a", "b"].map((templateId) => ({ templateId, orientation: 0 as const, difficulty: 0, weight: 1 }));
  const grid: WfcGrid = Array.from({ length: cells }, (_, x) => ({ x, y: 0, domain: options(), links: [] }));
  const state = { iterations: 0, maxIterations: 10000 };
  const solved = solveWfc(grid, () => true, () => 0.5, {
    state,
    accept: (solving) => solving.every((cell) => cell.domain.length === 1) && solving[0]!.domain[0]!.templateId === "a" ? [0] : true,
  });
  assert.equal(solved?.[0]!.domain[0]!.templateId, "b");
  assert.ok(state.iterations <= 2 * cells + 2, `${state.iterations} iterations`);
});

test("a solve that stops gaining depth while every check refuses gives up after its stall limit", () => {
  // Every full grid is refused, naming only the last cell, so the search keeps trying the
  // last cells' options without getting deeper: the churn the stall limit ends (#849).
  const cells = 12;
  const options = () => ["a", "b", "c"].map((templateId) => ({ templateId, orientation: 0 as const, difficulty: 0, weight: 1 }));
  const solve = (stallLimit?: number) => {
    const grid: WfcGrid = Array.from({ length: cells }, (_, x) => ({ x, y: 0, domain: options(), links: [] }));
    const state = { iterations: 0, maxIterations: 10000 }, stall = { most: 0 };
    let refusals = 0;
    const solved = solveWfc(grid, () => true, () => 0.5, {
      state, stall, ...(stallLimit === undefined ? {} : { stallLimit }),
      accept: (solving) => solving.every((cell) => cell.domain.length === 1) ? (refusals++, [cells - 1]) : true,
    });
    return { solved, refusals, iterations: state.iterations, most: stall.most };
  };
  const limited = solve(5);
  assert.equal(limited.solved, null);
  assert.equal(limited.refusals, 6, "it gives up on the refusal past the limit");
  assert.equal(limited.most, 6);
  const unlimited = solve();
  assert.equal(unlimited.solved, null);
  // Without a limit only the iteration cap ends it, after thousands of refusals.
  assert.ok(unlimited.refusals > 1000 && unlimited.iterations > 10000, `${unlimited.refusals} refusals`);
});
