/**
 * 51 step 4: placement and the `DeclaredGrid` view. The fixture library exercises every
 * placement rule, adjacency prescriptions that constrain the fill (a hut corner needs
 * hut across two of its sides, so corners only stand in clusters), and feature classes
 * painted only inside their owning set pieces.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { libraryFingerprint } from "../src/core.ts";
import { declaredGrid, layoutViolations, orientDesign } from "../src/chain/declared-grid.ts";
import { validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary, ChainTileDesign } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import type { ChainParams, DeclaredGrid, Layout, PlacedSlot } from "../src/chain/types.ts";
import { assertDeterministic, assertPure, assertRecomputable } from "./chain-harness.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const REGION_TYPES = new Set(Object.values(LIBRARY.cellClasses).map((cellClass) => cellClass.regionType));
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, lootChance: 0.04, lootTierStep: 0.09 };
const PLAYGROUND: ChainParams = { ...GAME, mode: "playground", zoneWidth: 2, zoneHeight: 1 };
const COLUMNS = 60;
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];

const layouts = new Map(SEEDS.map((seed) => [seed, placement(seed, GAME, LIBRARY)]));
const slotOf = (layout: Layout) => new Map(layout.slots.map((slot) => [`${slot.col},${slot.row}`, slot]));
const piece = (id: string) => LIBRARY.setPieces.find((p) => p.id === id)!;
const tileSet = (id: string) => LIBRARY.tileSets.find((s) => s.id === id)!;
const design = (id: string) => LIBRARY.tiles.find((t) => t.id === id)!;
const copy = (): ChainLibrary => structuredClone(LIBRARY);

test("the fixture library is valid", () => {
  assert.deepEqual(validateLibrary(LIBRARY, REGION_TYPES), { valid: true, errors: [] });
});

test("placement is pure and deterministic, and seeds differ", () => {
  const layout = assertPure("placement", placement, SEEDS[0]!, GAME, LIBRARY);
  assert.deepEqual(assertDeterministic("placement", placement, SEEDS[0]!, GAME, LIBRARY), layout);
  assert.deepEqual(layout, layouts.get(SEEDS[0]!));
  assert.notDeepEqual(layouts.get(SEEDS[1]!)!.slots, layout.slots);
});

test("a layout holds the seed, params, library fingerprint and every occupied slot, row by row", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  assert.equal(layout.seed, SEEDS[0]);
  assert.deepEqual(layout.params, GAME);
  assert.equal(layout.library, libraryFingerprint(LIBRARY));
  // 13 zones of 12 x 6 tiles.
  assert.equal(layout.slots.length, 13 * 72);
  const order = layout.slots.map((s) => [s.row, s.col]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
  assert.deepEqual(Object.keys(layout).sort(), ["library", "params", "seed", "setPieces", "slots"]);
});

test("every adjacency prescription is met and no any cell is asked for two classes", () => {
  for (const [seed, layout] of layouts) assert.deepEqual(layoutViolations(declaredGrid(layout, LIBRARY)), [], seed);
});

test("each set piece class places its quota as instances that never share a slot", () => {
  for (const [seed, layout] of layouts) {
    const byClass = new Map<string, number>();
    for (const instance of layout.setPieces) byClass.set(instance.setPieceClass, (byClass.get(instance.setPieceClass) ?? 0) + 1);
    assert.deepEqual(Object.fromEntries(byClass), Object.fromEntries(LIBRARY.setPieceClasses.map((c) => [c.id, c.quota])), seed);
    const covered = layout.setPieces.flatMap((instance) => instance.slots.map((s) => `${s.col},${s.row}`));
    assert.equal(new Set(covered).size, covered.length, `${seed}: instances share a slot`);
    assert.equal(new Set(layout.setPieces.map((i) => i.id)).size, layout.setPieces.length, `${seed}: instance ids repeat`);
    const enormous = layout.setPieces.filter((i) => i.setPieceClass === "enormous").map((i) => i.setPiece);
    assert.equal(new Set(enormous).size, 3, `${seed}: enormous pieces are distinct`);
  }
});

test("an instance's slots hold its set piece's tile sets, at its offsets and fixed orientations", () => {
  for (const [seed, layout] of layouts) {
    const at = slotOf(layout);
    for (const instance of layout.setPieces) {
      const { tiles } = piece(instance.setPiece);
      const anchor = instance.slots[0]!;
      tiles.forEach((tile, k) => {
        const slot = at.get(`${instance.slots[k]!.col},${instance.slots[k]!.row}`)!;
        assert.deepEqual([slot.col - anchor.col, slot.row - anchor.row], [tile.dx, tile.dy], `${seed} ${instance.id}`);
        assert.ok(tileSet(tile.tileSetId).members.includes(slot.design), `${seed} ${instance.id}: ${slot.design}`);
        if (tile.orientation !== undefined) assert.equal(slot.orientation, tile.orientation);
        else assert.ok(design(slot.design).orientations.includes(slot.orientation));
      });
    }
  }
});

test("placement rules are today's: west edge, east edge, middle band thirds, outer thirds", () => {
  for (const [seed, layout] of layouts) {
    const anchors = (setPieceClass: string) => layout.setPieces.filter((i) => i.setPieceClass === setPieceClass).map((i) => i.slots[0]!);
    assert.deepEqual(anchors("start").map((s) => s.col), [0], seed);
    // exit-yard is two tiles wide.
    assert.deepEqual(anchors("end").map((s) => s.col + 2 >= COLUMNS), [true], seed);
    const thirds = layout.setPieces.filter((i) => i.setPieceClass === "enormous").map((instance) => {
      const { col, row } = instance.slots[0]!;
      const width = Math.max(...piece(instance.setPiece).tiles.map((t) => t.dx)) + 1;
      assert.ok(col > COLUMNS / 4 && col + width < COLUMNS * 3 / 4, `${seed} ${instance.id} in the middle band`);
      return Math.floor(row / 10);
    });
    assert.deepEqual(thirds.sort(), [0, 1, 2], seed);
    for (const { col } of anchors("medium")) assert.ok(col < COLUMNS / 3 || col + 2 > COLUMNS * 2 / 3, `${seed} medium at ${col}`);
  }
});

test("feature classes stand only inside their owning set pieces, and the fill keeps eligible tiers", () => {
  const featureDesigns: Record<string, string> = { "arrival-pad": "start", "departure-pad": "end", "charger-pad": "charger" };
  for (const [seed, layout] of layouts) {
    const owner = new Map<string, string>();
    for (const instance of layout.setPieces) for (const s of instance.slots) owner.set(`${s.col},${s.row}`, instance.setPieceClass);
    for (const slot of layout.slots) {
      const key = `${slot.col},${slot.row}`;
      if (slot.design in featureDesigns) assert.equal(owner.get(key), featureDesigns[slot.design], `${seed} ${slot.design} at ${key}`);
      // hut-row is eligible in tiers 2 to 4, which are columns 12 to 47.
      if (slot.design === "hut-row" && !owner.has(key)) assert.ok(slot.col >= 12 && slot.col < 48, `${seed} hut-row at ${key}`);
    }
  }
});

test("the declared grid is pure, deterministic and recomputable from the layout and library", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const grid = assertPure("declared grid", declaredGrid, layout, LIBRARY);
  assertDeterministic("declared grid", declaredGrid, layout, LIBRARY);
  assertRecomputable("declared grid", grid, declaredGrid, layout, LIBRARY);
  assert.equal(grid.width, 360);
  assert.equal(grid.height, 180);
  assert.equal(grid.cells.filter((c) => c !== "").length, 13 * 72 * 36);
});

test("playground mode places no set pieces and fills the smaller map validly", () => {
  const layout = assertPure("placement", placement, "playground-1", PLAYGROUND, LIBRARY);
  assertDeterministic("placement", placement, "playground-1", PLAYGROUND, LIBRARY);
  assert.equal(layout.slots.length, 13 * 2);
  assert.deepEqual(layout.setPieces, []);
  assert.ok(layout.slots.every((s) => !["arrival-pad", "departure-pad", "charger-pad"].includes(s.design)));
  assert.deepEqual(layoutViolations(declaredGrid(layout, LIBRARY)), []);
});

test("game mode keeps its zone size", () => {
  assert.throws(() => placement("s", { ...PLAYGROUND, mode: "game" }, LIBRARY), /game mode requires 12 x 6 tile zones/);
});

test("placement fails explicitly, naming what failed", () => {
  const nowhere = copy();
  nowhere.setPieces.find((p) => p.id === "entry")!.eligibleTiers = [5];
  assert.throws(() => placement("s", GAME, nowhere), /set piece entry \(50\/50\)/);

  const few = copy();
  few.setPieceClasses.find((c) => c.id === "enormous")!.quota = 4;
  assert.throws(() => placement("s", GAME, few), /enormous needs 4 distinct set pieces and has 3/);

  const narrow = copy();
  for (const tile of narrow.tiles) tile.eligibleTiers = [1];
  assert.throws(() => placement("s", GAME, narrow), /no tile design is eligible for zone z-2-0 \(tier 3, bonus 2\)/);
});

// ── The declared grid, by hand ──────────────────────────────────────────────

const MARKED: ChainTileDesign = {
  id: "marked",
  defaultCellClass: "open",
  cells: ["h.....", "......", "......", "......", "......", "......"],
  legend: { h: "hut" },
  segments: { "h:0,1": { adjacency: "hut" }, "v:6,2": { passability: "passable" } },
  orientations: [0, 90, 180, 270],
};

test("a design turns clockwise, and the library's h:line,offset keys become run coordinates", () => {
  const at = (orientation: 0 | 90 | 180 | 270) => {
    const oriented = orientDesign(MARKED, orientation);
    return { hut: oriented.cells.indexOf("hut"), segments: Object.fromEntries(oriented.segments) };
  };
  // The library's h:0,1 is line 0, column 1: the kernel's h:1,0.
  assert.deepEqual(at(0), { hut: 0, segments: { "h:1,0": { adjacency: "hut" }, "v:6,2": { passability: "passable" } } });
  assert.deepEqual(at(90), { hut: 5, segments: { "v:6,1": { adjacency: "hut" }, "h:3,6": { passability: "passable" } } });
  assert.deepEqual(at(180), { hut: 35, segments: { "h:4,6": { adjacency: "hut" }, "v:0,3": { passability: "passable" } } });
  assert.deepEqual(at(270), { hut: 30, segments: { "v:0,4": { adjacency: "hut" }, "h:2,0": { passability: "passable" } } });
});

/** A playground layout with one-tile zones: the 5 x 5 diamond of 13 tiles. */
function handLayout(slots: Record<string, Omit<PlacedSlot, "col" | "row">>): Layout {
  const params: ChainParams = { ...PLAYGROUND, zoneWidth: 1, zoneHeight: 1 };
  const mask: PlacedSlot[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++)
    if (Math.abs(col - 2) + Math.abs(row - 2) <= 2) mask.push({ col, row, ...(slots[`${col},${row}`] ?? { design: "field", orientation: 0 }) });
  return { seed: "hand", params, library: "hand", slots: mask, setPieces: [] };
}

test("the declared grid keeps each side's prescriptions apart, and marks outside cells", () => {
  const layout = handLayout({ "2,2": { design: "hut-corner", orientation: 0 }, "0,2": { design: "hut-row", orientation: 180 } });
  const grid = declaredGrid(layout, LIBRARY);
  assert.equal(grid.width, 30);
  assert.equal(grid.cells[0], "");
  assert.equal(grid.cells[12 * 30 + 12], "hut");
  // Inside a tile the design owns both sides.
  assert.deepEqual(grid.segments["v:15,13"], { lower: { passability: "passable" }, upper: { passability: "passable" } });
  // On a tile's near edge it owns the upper side only; the field across states nothing.
  assert.deepEqual(grid.segments["h:12,12"], { upper: { adjacency: "hut" } });
  // hut-row turned 180 prescribes hut across its west edge, which faces the outside;
  // its passable pair turns from rows 4 and 5 to rows 1 and 0.
  assert.deepEqual(grid.segments["v:0,12"], { upper: { adjacency: "hut", passability: "passable" } });
  assert.deepEqual(grid.segments["v:0,17"], { upper: { adjacency: "hut" } });
});

test("violations name unmet adjacency, but a prescription facing the outside is met", () => {
  const outside = declaredGrid(handLayout({ "0,2": { design: "hut-row", orientation: 180 } }), LIBRARY);
  assert.deepEqual(layoutViolations(outside), []);
  const unmet = declaredGrid(handLayout({ "2,2": { design: "hut-corner", orientation: 0 } }), LIBRARY);
  const violations = layoutViolations(unmet);
  assert.equal(violations.length, 6);
  assert.ok(violations.includes("h:12,12 requires hut across, found open"), violations.join("; "));
  assert.ok(violations.includes("v:12,12 requires hut across, found open"), violations.join("; "));
});

test("an any cell may be asked for one class from two sides, never two classes", () => {
  const grid = (west: string, south: string): DeclaredGrid => ({
    width: 2, height: 2, cells: ["open", "any", "open", "open"],
    segments: { "v:1,0": { lower: { adjacency: west } }, "h:1,1": { upper: { adjacency: south } } },
  });
  assert.deepEqual(layoutViolations(grid("hut", "hut")), []);
  assert.deepEqual(layoutViolations(grid("hut", "open")), ["any cell 1,0 is asked for hut and open"]);
});
