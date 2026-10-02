/**
 * 51 step 5: Resolution and Regions. The fixture layouts hold to the harnesses and
 * derive only passable portals; small hand-placed layouts pin each rule: how `any`
 * resolves, that the map's outside guarantees nothing, how portals derive from
 * guarantees along boundaries, and that a portal shorter than a hunter is refused.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boundaryRuns } from "../../kernel/run.ts";
import { RUN_CASES, runCaseParts } from "../../kernel/run-cases.ts";
import { MIN_PORTAL_LENGTH } from "../../kernel/scale.ts";
import { declaredGrid } from "../src/chain/declared-grid.ts";
import type { ChainLibrary, ChainTileDesign } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Layout, LayoutRegions, PlacedSlot, ResolvedLayout } from "../src/chain/types.ts";
import { assertDeterministic, assertPure, assertRecomputable } from "./chain-harness.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];
const layouts = new Map(SEEDS.map((seed) => [seed, placement(seed, GAME, LIBRARY)]));
const derive = (layout: Layout, library: ChainLibrary): LayoutRegions => regions(resolution(layout, library), layout.seed);

test("resolution and regions are pure, deterministic and recomputable from the Layout", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const resolved = assertPure("resolution", resolution, layout, LIBRARY);
  assert.deepEqual(assertDeterministic("resolution", resolution, layout, LIBRARY), resolved);
  assertRecomputable("resolution", resolved, resolution, layout, LIBRARY);
  const found = assertPure("regions", regions, resolved, layout.seed);
  assert.deepEqual(assertDeterministic("regions", regions, resolved, layout.seed), found);
  assertRecomputable("regions", found, derive, layout, LIBRARY);
});

test("the fixture's layouts resolve every any cell and derive only passable portals", () => {
  for (const [seed, layout] of layouts) {
    const resolved = resolution(layout, LIBRARY);
    assert.ok(!resolved.cells.includes("any"), seed);
    const found = regions(resolved, seed);
    assert.deepEqual(portalViolations(found), [], seed);
    assert.ok(found.portals.length > 0, seed);
  }
});

test("regions partition the map's cells, and each is 4-connected with one class", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const resolved = resolution(layout, LIBRARY);
  const found = regions(resolved, layout.seed);
  const owner = new Map<number, string>();
  for (const region of found.regions) for (const cell of region.cells) {
    assert.ok(!owner.has(cell));
    owner.set(cell, region.id);
    assert.equal(resolved.cells[cell], region.class);
  }
  assert.equal(owner.size, resolved.cells.filter((c) => c !== "").length);
  // No two regions of one class touch, or they'd be one region.
  for (const boundary of found.boundaries) {
    const [a, b] = [boundary.a, boundary.b].map((id) => found.regions.find((r) => r.id === id)!.class);
    assert.notEqual(a, b, `${boundary.a} and ${boundary.b}`);
  }
});

test("a hut-cluster set piece forms one 6 x 6 hut region across four tiles (52's worked case)", () => {
  for (const [seed, layout] of layouts) {
    const found = derive(layout, LIBRARY);
    const width = declaredGrid(layout, LIBRARY).width;
    for (const instance of layout.setPieces.filter((i) => i.setPiece === "hut-cluster")) {
      const col = Math.min(...instance.slots.map((s) => s.col)), row = Math.min(...instance.slots.map((s) => s.row));
      // The four corners' huts meet at the cluster's centre junction.
      const junction = (row * 6 + 6) * width + col * 6 + 6;
      const region = found.regions.find((r) => r.cells.includes(junction))!;
      assert.equal(region.class, "hut", seed);
      assert.equal(region.cells.length, 36, seed);
    }
  }
});

test("region ids and seeds follow the region's own cells, so an unrelated change leaves them be", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const before = derive(layout, LIBRARY);
  const last = layout.slots.at(-1)!;
  const changed = { ...layout, slots: [...layout.slots.slice(0, -1), { ...last, design: "departure-pad", orientation: 0 as const }] };
  const after = new Map(derive(changed, LIBRARY).regions.map((r) => [r.id, r]));
  const lastCell = (last.row * 6) * 360 + last.col * 6;
  const untouched = before.regions.filter((r) => r.cells.every((c) => Math.abs(Math.floor(c / 360) - Math.floor(lastCell / 360)) > 6));
  assert.ok(untouched.length > 100);
  for (const region of untouched) assert.deepEqual(after.get(region.id), region);
  assert.notEqual(derive({ ...layout, seed: "other" }, LIBRARY).regions[0]!.seed, before.regions[0]!.seed);
});

// ── Hand-placed layouts ─────────────────────────────────────────────────────

/** Tiles for the rules below. Library keys: `h:y,x` (line first), `v:x,y`. */
const column5 = (mark: string) => Array.from({ length: 6 }, () => `.....${mark}`);
const HAND_TILES: ChainTileDesign[] = [
  { id: "field", defaultCellClass: "open", orientations: [0] },
  // A hut column on the tile's east side, with passable segments on its west face.
  { id: "hut-low", defaultCellClass: "open", cells: column5("h"), legend: { h: "hut" }, orientations: [0],
    segments: { "v:5,5": { passability: "passable" } } },
  { id: "hut-high", defaultCellClass: "open", cells: column5("h"), legend: { h: "hut" }, orientations: [0],
    segments: { "v:5,0": { passability: "passable" } } },
  { id: "hut-mid", defaultCellClass: "open", cells: column5("h"), legend: { h: "hut" }, orientations: [0],
    segments: { "v:5,2": { passability: "passable" }, "v:5,3": { passability: "passable" } } },
  // The same pair, but the region across changes between its two segments.
  { id: "hut-shed", defaultCellClass: "open", cells: [".....h", ".....h", ".....h", ".....s", ".....s", ".....s"],
    legend: { h: "hut", s: "shed" }, orientations: [0],
    segments: { "v:5,2": { passability: "passable" }, "v:5,3": { passability: "passable" } } },
  // A passable pair between two hut cells: a guarantee inside one region.
  { id: "hut-inner", defaultCellClass: "open", cells: column5("h").map(() => "....hh"), legend: { h: "hut" }, orientations: [0],
    segments: { "v:5,2": { passability: "passable" }, "v:5,3": { passability: "passable" } } },
  // A passable pair on the north edge, and an `any` stated on the east edge.
  { id: "gate-north", defaultCellClass: "open", orientations: [0],
    segments: { "h:0,2": { passability: "passable" }, "h:0,3": { passability: "passable" }, "v:6,1": { passability: "any" } } },
  { id: "borderland", defaultCellClass: "open", cells: column5("a"), legend: { a: "any" }, orientations: [0] },
  // Asks for hut across the top half of its west edge.
  { id: "wants-hut", defaultCellClass: "open", orientations: [0],
    segments: { "v:0,0": { adjacency: "hut" }, "v:0,1": { adjacency: "hut" }, "v:0,2": { adjacency: "hut" } } },
];
const HAND: ChainLibrary = { ...LIBRARY, tiles: HAND_TILES };
const PLAYGROUND: ChainParams = { ...GAME, mode: "playground", zoneWidth: 1, zoneHeight: 1 };

/** Only the given slots, `col,row` to design; every other cell is outside the mask. */
function hand(slots: Record<string, string>, params = PLAYGROUND): { resolved: ResolvedLayout; found: LayoutRegions } {
  const placed: PlacedSlot[] = Object.entries(slots).map(([at, design]) => {
    const [col, row] = at.split(",").map(Number) as [number, number];
    return { col, row, design, orientation: 0 };
  });
  const layout: Layout = { seed: "hand", params, library: "hand", slots: placed, setPieces: [] };
  const resolved = resolution(layout, HAND);
  return { resolved, found: regions(resolved, layout.seed) };
}

test("a region's id and seed follow its cells' coordinates, not the map's width", () => {
  const narrow = hand({ "1,1": "hut-mid" });
  const wide = hand({ "1,1": "hut-mid" }, { ...PLAYGROUND, zoneWidth: 2 });
  assert.notEqual(wide.resolved.width, narrow.resolved.width);
  assert.deepEqual(wide.found.regions.map((r) => [r.id, r.seed]), narrow.found.regions.map((r) => [r.id, r.seed]));
});

test("a one-segment portal between two regions is refused, naming the regions and cells", () => {
  const { found } = hand({ "1,1": "hut-low" });
  assert.equal(MIN_PORTAL_LENGTH, 2);
  assert.deepEqual(found.portals.map(({ axis, x, y, length }) => ({ axis, x, y, length })), [{ axis: "v", x: 11, y: 11, length: 1 }]);
  assert.deepEqual(portalViolations(found),
    ["portal between hut@11,6 and open@6,6 is 1 segment long, shorter than a hunter's 2, at cells 10,11|11,11"]);
});

test("a two-segment portal passes, inside a tile or across a tile seam", () => {
  const inside = hand({ "1,1": "hut-mid" }).found;
  assert.deepEqual(inside.portals.map((p) => p.length), [2]);
  assert.deepEqual(portalViolations(inside), []);
  // hut-low's last row and hut-high's first meet at the seam between rows 11 and 12.
  const seam = hand({ "1,1": "hut-low", "1,2": "hut-high" }).found;
  assert.deepEqual(seam.portals.map(({ id, axis, x, y, length }) => ({ id, axis, x, y, length })),
    [{ id: "hut@11,6~open@6,6~v:11,11", axis: "v", x: 11, y: 11, length: 2 }]);
  assert.deepEqual(portalViolations(seam), []);
  assert.deepEqual(seam.graph, [{ a: "hut@11,6", b: "open@6,6", portals: ["hut@11,6~open@6,6~v:11,11"] }]);
});

test("a passable pair split where the region across changes is two short portals", () => {
  const { found } = hand({ "1,1": "hut-shed" });
  assert.deepEqual(found.portals.map((p) => [p.b === "open@6,6" ? p.a : p.b, p.length]), [["hut@11,6", 1], ["shed@11,9", 1]]);
  assert.equal(portalViolations(found).length, 2);
});

test("an outward prescription at the map's edge is valid and not guaranteed", () => {
  const { resolved, found } = hand({ "0,0": "gate-north" });
  assert.deepEqual(resolved.segments["h:2,0"], { guarantee: "none", stated: [null, "passable"] });
  assert.deepEqual(resolved.segments["h:3,0"], { guarantee: "none", stated: [null, "passable"] });
  // Facing cells outside the mask is the same: nothing is across.
  assert.deepEqual(resolved.segments["v:6,1"], { guarantee: "none", stated: ["any", null] });
  assert.deepEqual(found.portals, []);
  assert.deepEqual(portalViolations(found), []);
});

test("a guarantee is kept with what each side stated, and one side's passable suffices", () => {
  const { resolved } = hand({ "0,0": "field", "0,1": "gate-north" });
  assert.deepEqual(resolved.segments["h:2,6"], { guarantee: "guaranteed", stated: ["unstated", "passable"] });
  // Segments that state only adjacency, or nothing, aren't listed.
  assert.equal(Object.keys(resolved.segments).length, 3);
});

test("a guarantee with one region on both sides forms no portal (17 M8)", () => {
  const { resolved, found } = hand({ "1,1": "hut-inner" });
  assert.equal(resolved.segments["v:11,8"]!.guarantee, "guaranteed");
  assert.deepEqual(found.portals, []);
  assert.deepEqual(found.graph, []);
  assert.equal(found.boundaries.length, 1);
});

test("an any cell takes the class asked of it, and otherwise open", () => {
  const { resolved, found } = hand({ "0,0": "borderland", "1,0": "wants-hut" });
  const width = resolved.width;
  for (let y = 0; y < 6; y++) assert.equal(resolved.cells[y * width + 5], y < 3 ? "hut" : "open", `row ${y}`);
  assert.deepEqual(found.regions.map((r) => [r.id, r.cells.length]), [["open@0,0", 69], ["hut@5,0", 3]]);
});

test("macro's boundaries agree with the kernel's run definition on every worked case", () => {
  for (const runCase of RUN_CASES) {
    const width = runCase.rows[0]!.length;
    const cells = runCase.rows.flatMap((row) => [...row].map((mark) => mark === "." ? "" : mark));
    const resolved: ResolvedLayout = { width, height: runCase.rows.length, cells, segments: {} };
    const found = regions(resolved, "runs");
    // A letter may be several regions (it is the class); group them back to the letter.
    const classOf = new Map(found.regions.map((r) => [r.id, r.class]));
    const grouped = new Map<string, { a: string; b: string; runs: typeof found.boundaries[number]["run"][] }>();
    for (const { a, b, run } of found.boundaries) {
      const [ca, cb] = [classOf.get(a)!, classOf.get(b)!].sort() as [string, string];
      const key = `${ca}|${cb}`;
      if (!grouped.has(key)) grouped.set(key, { a: ca, b: cb, runs: [] });
      grouped.get(key)!.runs.push(run);
    }
    const actual = [...grouped.values()].sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b))
      .map(({ a, b, runs }) => ({ a, b, runs: runs.sort((p, q) => p.axis.localeCompare(q.axis) || p.y - q.y || p.x - q.x) }));
    assert.deepEqual(actual, runCase.boundaries, runCase.name);
    assert.deepEqual(boundaryRuns(runCaseParts(runCase)), runCase.boundaries, runCase.name);
  }
});
