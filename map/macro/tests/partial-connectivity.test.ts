import assert from "node:assert/strict";
import test from "node:test";
import { orientedDesigns, segmentCells } from "../src/chain/declared-grid.ts";
import type { ChainLibrary, ChainTileDesign, PassabilityPrescription } from "../src/chain/library.ts";
import { placementSeams } from "../src/chain/partial-connectivity.ts";
import type { PartialPlacedTile, PlacementSlot } from "../src/chain/partial-connectivity.ts";
import { resolution, resolveSettledClass } from "../src/chain/resolution.ts";
import type { Layout, Orientation, SegmentKey } from "../src/chain/types.ts";

const tile = (id: string, declared: string, segments: ChainTileDesign["segments"] = {}): ChainTileDesign =>
  ({ id, defaultCellClass: declared, segments, orientations: [0, 90, 180, 270] });
const library = (...tiles: ChainTileDesign[]): ChainLibrary => ({
  version: 3, name: "partial", zonePlan: "diamond", zoneWidth: 1, zoneHeight: 1,
  passabilityRules: "matched", cellClasses: { open: { regionType: "open" }, hut: { regionType: "hut" } },
  tiles, tileSets: [], setPieces: [], setPieceClasses: [],
});
const slots: PlacementSlot[] = [{ slot: 0, x: 0, y: 0 }, { slot: 1, x: 1, y: 0 }];
const placed = (...ids: string[]) => new Map<number, PartialPlacedTile>(ids.map((design, slot) => [slot, { design, orientation: 0 }]));
const seam = (lib: ChainLibrary, mask = slots, tiles = placed("left", "right"), key: SegmentKey = "v:6,0") => {
  const found = placementSeams(lib, mask, tiles).find((entry) => entry.key === key);
  assert.ok(found, key);
  return found;
};

test("settlement shares the solver's asked, waiting, then default rule", () => {
  assert.equal(resolveSettledClass("hut", "open", true), "hut");
  assert.equal(resolveSettledClass("any", "hut", true), "hut");
  assert.equal(resolveSettledClass("any", undefined, true), undefined);
  assert.equal(resolveSettledClass("any", undefined, false), "open");
});

test("any plus a hint follows settled classes, and an unknown neighbour keeps it unresolved", () => {
  const left = tile("left", "any", { "v:6,0": { passability: "any" } });
  const right = tile("right", "open", { "v:0,0": { passability: "not-passable-hint" } });
  const same = seam(library(left, right));
  assert.equal(same.kind, "internal-hint");
  assert.equal(same.lower.declared, "any");
  assert.equal(same.lower.resolved, "open");
  assert.equal(same.upper.passability, "not-passable-hint");
  assert.equal(seam(library(left, { ...right, defaultCellClass: "hut" })).kind, "blocked");
  const unsettled = seam(library(left, right), [...slots, { slot: 2, x: 0, y: -1 }]);
  assert.equal(unsettled.kind, "unresolved");
  assert.equal(unsettled.lower.resolved, undefined);
  const asked = { ...right, defaultCellClass: "hut", segments: { "v:0,0": { passability: "not-passable-hint" as const, adjacency: "hut" } } };
  assert.equal(seam(library(left, asked), [...slots, { slot: 2, x: 0, y: -1 }]).kind, "internal-hint");
});

test("explicit passable guarantees crossing with unsettled any, and inside one class", () => {
  const lib = library(tile("left", "any", { "v:6,0": { passability: "passable" } }), tile("right", "open"));
  assert.equal(seam(lib, [...slots, { slot: 2, x: 0, y: -1 }]).kind, "guaranteed");
  assert.equal(seam(lib).kind, "guaranteed");
  assert.equal(seam(lib, slots, placed("left")).kind, "unresolved");
});

test("two any classes can settle differently across an authored hint and internal boundary", () => {
  const lib = library(tile("left", "any", { "v:6,0": { passability: "not-passable-hint" } }),
    tile("right", "any", { "v:0,0": { adjacency: "hut", passability: "any" } }));
  const across = seam(lib);
  assert.equal(across.lower.resolved, "hut");
  assert.equal(across.upper.resolved, "open");
  assert.equal(across.kind, "blocked");
  const inside = seam(lib, slots, placed("left", "right"), "v:5,0");
  assert.equal(inside.lower.declared, "any");
  assert.equal(inside.upper.declared, "any");
  assert.equal(inside.lower.resolved, "open");
  assert.equal(inside.upper.resolved, "hut");
  assert.equal(inside.kind, "guaranteed");
});

test("a mask hole is outside while an unplaced in-mask slot remains unknown", () => {
  const lib = library(tile("left", "open", { "v:6,0": { passability: "passable" } }), tile("right", "hut"));
  const outside = seam(lib, slots.slice(0, 1), placed("left"));
  assert.equal(outside.kind, "outside");
  assert.equal(outside.upper.state, "outside");
  const unknown = seam(lib, slots, placed("left"));
  assert.equal(unknown.kind, "unresolved");
  assert.deepEqual(unknown.upper, { state: "unplaced" });
  assert.equal(seam(lib, slots, new Map()).kind, "unresolved");
});

test("contradictory asks, fixed-class mismatch and invalid matched sides are conflicts", () => {
  const lib = library(tile("left", "any", { "v:6,0": { passability: "passable" } }),
    tile("right", "hut", { "v:0,0": { adjacency: "hut" } }),
    tile("north", "open", { "h:6,5": { adjacency: "open" } }));
  const mask = [...slots, { slot: 2, x: 0, y: -1 }];
  const conflict = seam(lib, mask, placed("left", "right", "north"));
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.lower.resolved, undefined);
  assert.equal(seam({ ...lib, tiles: [{ ...lib.tiles[0]!, defaultCellClass: "open" }, ...lib.tiles.slice(1)] }).kind, "conflict");
  const invalid = library(tile("left", "open", { "v:6,0": { passability: "passable" } }),
    tile("right", "hut", { "v:0,0": { passability: "not-passable-hint" } }));
  assert.equal(seam(invalid).kind, "conflict");
  assert.equal(seam({ ...invalid, passabilityRules: "either-side" }).kind, "guaranteed");
});

test("orientations preserve kernel coordinates, side ownership and one seam per segment", () => {
  const lib = library(tile("left", "open", { "v:6,0": { passability: "passable", adjacency: "hut" },
    "h:2,3": { passability: "not-passable-hint" } }), tile("right", "hut", { "v:0,0": { passability: "any" } }));
  const turned = orientedDesigns(lib);
  for (const orientation of [0, 90, 180, 270] as Orientation[]) {
    const tiles = new Map<number, PartialPlacedTile>([[0, { design: "left", orientation }]]);
    const seams = placementSeams(lib, [{ slot: 0, x: 2, y: 3 }], tiles, turned);
    assert.equal(new Set(seams.map((entry) => entry.key)).size, seams.length);
    for (const [key, stated] of turned("left", orientation).segments) {
      const [axis, pair] = key.split(":");
      const [x, y] = pair!.split(",").map(Number) as [number, number];
      const global: SegmentKey = `${axis as "h" | "v"}:${12 + x},${18 + y}`;
      const found = seams.find((entry) => entry.key === global)!;
      const line = axis === "v" ? x : y;
      assert.equal(found.lower.passability, line === 0 ? undefined : stated.passability);
      assert.equal(found.upper.passability, line === 6 ? undefined : stated.passability);
      assert.deepEqual(found.b, { x: 12 + x + (axis === "h" ? 1 : 0), y: 18 + y + (axis === "v" ? 1 : 0) });
    }
  }
  const shared = placementSeams(lib, slots, placed("left", "right"));
  assert.equal(shared.filter((entry) => entry.key === "v:6,0").length, 1);
  assert.equal(seam(lib).lower.passability, "passable");
  assert.equal(seam(lib).upper.passability, "any");
});

test("completed seam classes and crossing guarantees agree with actual resolution", () => {
  const values: (PassabilityPrescription | undefined)[] = ["passable", "any", "not-passable-hint", undefined];
  for (const rules of ["matched", "either-side"] as const) for (const leftClass of ["any", "hut"]) for (const rightClass of ["any", "hut"]) for (const a of values) for (const b of values) {
    if (rules === "matched" && (a === "passable" && b === "not-passable-hint" || b === "passable" && a === "not-passable-hint")) continue;
    const lib = library(tile("left", leftClass, { "v:6,0": { passability: a } }), tile("right", rightClass, { "v:0,0": { passability: b } }));
    lib.passabilityRules = rules;
    const layout: Layout = { seed: "partial", library: "hand", setPieces: [],
      params: { mode: "playground", zoneWidth: 1, zoneHeight: 1, exitCount: 1, contestantCount: 1, hunterCount: 1, lootChance: 0, lootTierStep: 0 },
      slots: slots.map((slot, i) => ({ col: slot.x, row: slot.y, design: i ? "right" : "left", orientation: 0 })) };
    const resolved = resolution(layout, lib);
    for (const entry of placementSeams(lib, slots, placed("left", "right"))) {
      const [lower, upper] = segmentCells(resolved, entry.key);
      assert.equal(entry.lower.resolved, lower === undefined ? undefined : resolved.cells[lower], entry.key);
      assert.equal(entry.upper.resolved, upper === undefined ? undefined : resolved.cells[upper], entry.key);
      assert.equal(entry.kind === "guaranteed", resolved.segments[entry.key]?.guarantee === "guaranteed", entry.key);
    }
  }
});

test("rollback resamples classes with a shared orientation cache and omits uniform interiors", () => {
  const lib = library(tile("left", "any"), tile("right", "hut", { "v:0,0": { adjacency: "hut" } }));
  const tiles = placed("left"), turned = orientedDesigns(lib);
  const first = placementSeams(lib, slots, tiles, turned);
  tiles.set(1, { design: "right", orientation: 0 });
  assert.equal(placementSeams(lib, slots, tiles, turned).find((entry) => entry.key === "v:6,0")!.lower.resolved, "hut");
  tiles.delete(1);
  assert.deepEqual(placementSeams(lib, slots, tiles, turned), first);
  const uniform = placementSeams(library(tile("left", "any")), slots.slice(0, 1), placed("left"));
  assert.equal(uniform.length, 24);
});
