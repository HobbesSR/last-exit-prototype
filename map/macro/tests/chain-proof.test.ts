/**
 * 51 step 6: the Proof. The fixture layouts hold to the harnesses and partition their
 * regions into the region graph's components; small hand-placed layouts pin which
 * regions a portal joins, that joining is transitive, and what the gate (17 M2) names.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ChainLibrary, ChainTileDesign } from "../src/chain/library.ts";
import { placement } from "../src/chain/placement.ts";
import { proof, proofViolations } from "../src/chain/proof.ts";
import { regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { ChainParams, Layout, LayoutRegions, PlacedSlot, ReachabilityProof } from "../src/chain/types.ts";
import { assertDeterministic, assertPure, assertRecomputable } from "./chain-harness.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, lootChance: 0.04, lootTierStep: 0.09 };
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];
const layouts = new Map(SEEDS.map((seed) => [seed, placement(seed, GAME, LIBRARY)]));
const derive = (layout: Layout, library: ChainLibrary): LayoutRegions => regions(resolution(layout, library), layout.seed);
const prove = (layout: Layout, library: ChainLibrary): ReachabilityProof => proof(derive(layout, library));

test("the proof is pure, deterministic and recomputable from the Layout", () => {
  const layout = layouts.get(SEEDS[0]!)!;
  const found = derive(layout, LIBRARY);
  const reachability = assertPure("proof", proof, found);
  assert.deepEqual(assertDeterministic("proof", proof, found), reachability);
  assertRecomputable("proof", reachability, prove, layout, LIBRARY);
});

test("the fixture's components partition its regions, and match a search of the region graph", () => {
  for (const [seed, layout] of layouts) {
    const found = derive(layout, LIBRARY);
    const { components } = proof(found);
    assert.deepEqual(components.flat().sort(), found.regions.map((r) => r.id).sort(), seed);
    // A plain breadth-first search over the graph, from each component's first region.
    const next = new Map<string, string[]>();
    for (const { a, b } of found.graph) {
      next.set(a, [...next.get(a) ?? [], b]);
      next.set(b, [...next.get(b) ?? [], a]);
    }
    for (const component of components) {
      const seen = new Set([component[0]!]);
      for (const id of seen) for (const other of next.get(id) ?? []) seen.add(other);
      assert.deepEqual([...seen].sort(), [...component].sort(), seed);
    }
    // The gate names every component but the spawn region's.
    assert.equal(proofViolations({ components }, found, LIBRARY).length, components.length - 1, seed);
  }
});

// ── Hand-placed layouts ─────────────────────────────────────────────────────

/** Tiles for the rules below. A column of one class on the tile's east side. */
const column = (mark: string) => Array.from({ length: 6 }, () => `.....${mark}`);
const passable = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, { passability: "passable" as const }]));
const HAND_TILES: ChainTileDesign[] = [
  { id: "field", defaultCellClass: "open", orientations: [0] },
  // A hut column with a portal on its west face, its east face, both, or neither.
  { id: "hut-west", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0],
    segments: passable("v:5,2", "v:5,3") },
  { id: "hut-east", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0],
    segments: passable("v:6,2", "v:6,3") },
  { id: "hut-through", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0],
    segments: passable("v:5,2", "v:5,3", "v:6,2", "v:6,3") },
  { id: "hut-shut", defaultCellClass: "open", cells: column("h"), legend: { h: "hut" }, orientations: [0] },
  // The class that promises a spawn, with no portal.
  { id: "arrival-shut", defaultCellClass: "open", cells: column("a"), legend: { a: "arrival" }, orientations: [0] },
];
const HAND: ChainLibrary = { ...LIBRARY, tiles: HAND_TILES };
const PLAYGROUND: ChainParams = { ...GAME, mode: "playground", zoneWidth: 1, zoneHeight: 1 };

/** Only the given slots, `col,row` to design; every other cell is outside the mask. */
function hand(slots: Record<string, string>): { found: LayoutRegions; reachability: ReachabilityProof } {
  const placed: PlacedSlot[] = Object.entries(slots).map(([at, design]) => {
    const [col, row] = at.split(",").map(Number) as [number, number];
    return { col, row, design, orientation: 0 };
  });
  const layout: Layout = { seed: "hand", params: PLAYGROUND, library: "hand", slots: placed, setPieces: [] };
  const found = derive(layout, HAND);
  return { found, reachability: proof(found) };
}

test("a portal joins the two regions it lies between", () => {
  const { found, reachability } = hand({ "1,1": "hut-west" });
  assert.deepEqual(reachability.components, [["open@6,6", "hut@11,6"]]);
  assert.deepEqual(proofViolations(reachability, found, HAND), []);
});

test("regions that meet without a portal are separate components, and the gate names the one left out", () => {
  const { found, reachability } = hand({ "1,1": "hut-shut" });
  assert.equal(found.boundaries.length, 1);
  assert.deepEqual(reachability.components, [["open@6,6"], ["hut@11,6"]]);
  // No spawn region here, so the largest component stands in for it.
  assert.deepEqual(proofViolations(reachability, found, HAND),
    ["region hut@11,6 has no portal path to the largest component, from open@6,6"]);
});

test("joining is transitive, and a portal on one side doesn't join the region beyond", () => {
  // open | hut | open: the hut column stands between two open regions.
  const through = hand({ "1,1": "hut-through", "2,1": "field" });
  assert.deepEqual(through.reachability.components, [["open@6,6", "hut@11,6", "open@12,6"]]);
  const west = hand({ "1,1": "hut-west", "2,1": "field" });
  assert.deepEqual(west.reachability.components, [["open@6,6", "hut@11,6"], ["open@12,6"]]);
  const east = hand({ "1,1": "hut-east", "2,1": "field" });
  assert.deepEqual(east.reachability.components, [["open@6,6"], ["hut@11,6", "open@12,6"]]);
  assert.deepEqual(proofViolations(west.reachability, west.found, HAND),
    ["region open@12,6 has no portal path to the largest component, from open@6,6"]);
});

test("the gate holds every region to the spawn region's component, however small", () => {
  // The arrival column promises the spawn (its class's features), and nothing reaches it.
  const { found, reachability } = hand({ "1,1": "arrival-shut", "2,1": "hut-through", "3,1": "field" });
  assert.deepEqual(reachability.components, [["open@6,6"], ["arrival@11,6"], ["open@12,6", "hut@17,6", "open@18,6"]]);
  assert.deepEqual(proofViolations(reachability, found, HAND), [
    "region open@6,6 has no portal path to spawn region arrival@11,6",
    "regions open@12,6, hut@17,6, open@18,6 have no portal path to spawn region arrival@11,6",
  ]);
});
