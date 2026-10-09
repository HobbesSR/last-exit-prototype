import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { libraryFingerprint } from "../src/coding.ts";
import { validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary, PassabilityPrescription } from "../src/chain/library.ts";
import { openFaceRule } from "../src/chain/open-face.ts";
import { generateChainMap, mapViews } from "../src/chain/map.ts";
import { chainMapToBson, chainMapToJson, readChainMap } from "../src/chain/saving.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import type { Layout } from "../src/chain/types.ts";
import type { WfcGrid, TileOption } from "../src/wfc.ts";
import { STUB_ENGINES, stubCompose } from "./chain-stub.ts";

const BASE = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const TYPES = new Set(Object.values(BASE.cellClasses).map((entry) => entry.regionType));
const VALUES = ["passable", "any", "not-passable-hint", undefined] as const;
// Rows and columns follow VALUES. Omission deliberately differs from authored any.
const GUARANTEES = [[true, true, true, true], [true, true, false, false],
  [true, false, false, false], [true, false, false, false]];
const option = (templateId: string): TileOption => ({ templateId, orientation: 0, difficulty: 0, weight: 1 });
const edge = (line: number, value: PassabilityPrescription | undefined, length = 6) =>
  value === undefined ? {} : Object.fromEntries(Array.from({ length }, (_, y) => [`v:${line},${y}`, { passability: value }]));
function library(a: PassabilityPrescription | undefined, b: PassabilityPrescription | undefined, length = 6): ChainLibrary {
  return { ...BASE, tiles: [
    { id: "left", defaultCellClass: "hut", orientations: [0], segments: edge(6, a, length) },
    { id: "right", defaultCellClass: "open", orientations: [0], segments: edge(0, b, length) },
  ], tileSets: [], setPieces: [], setPieceClasses: [] };
}
const layout: Layout = { seed: "passability", library: "hand", setPieces: [],
  params: { mode: "playground", zoneWidth: 1, zoneHeight: 1, exitCount: 1, contestantCount: 1,
    hunterCount: 1, lootChance: 0, lootTierStep: 0 },
  slots: [{ col: 0, row: 0, design: "left", orientation: 0 }, { col: 1, row: 0, design: "right", orientation: 0 }] };
function grid(right = ["right"]): WfcGrid {
  return [{ x: 0, y: 0, domain: [option("left")], links: [] },
    { x: 1, y: 0, domain: right.map(option), links: [] }];
}

test("all paired prescriptions resolve with provenance and the solver agrees", () => {
  for (const [i, a] of VALUES.entries()) for (const [j, b] of VALUES.entries()) {
    const lib = library(a, b), expected = GUARANTEES[i]![j]!;
    const resolved = resolution(layout, lib), segment = resolved.segments["v:6,0"];
    if (a === undefined && b === undefined) assert.equal(segment, undefined);
    else assert.deepEqual(segment, { guarantee: expected ? "guaranteed" : "none", stated: [a ?? "unstated", b ?? "unstated"] });
    const found = regions(resolved, layout.seed);
    assert.deepEqual(found.portals.map((p) => p.length), expected ? [6] : []);
    assert.deepEqual(portalViolations(found), []);
    const slots = grid();
    assert.equal(openFaceRule(lib, slots, 2, 1)(slots, [0, 1]) === true, expected, `${a}/${b}`);
    // Each outward authored prescription retains provenance but promises nothing.
    const outside = resolution({ ...layout, slots: layout.slots.slice(0, 1) }, lib).segments["v:6,0"];
    if (a !== undefined) assert.deepEqual(outside, { guarantee: "none", stated: [a, null] });
  }
});

test("any+any portals are derived before the short-portal check", () => {
  const lib = library("any", "any", 1), slots = grid(), reasons: string[] = [];
  assert.notEqual(openFaceRule(lib, slots, 2, 1, (reason) => reasons.push(reason))(slots, [0, 1]), true);
  assert.match(reasons[0]!, /portal.*1 segment.*shorter/);
  assert.equal(portalViolations(regions(resolution(layout, lib), layout.seed)).length, 1);
});

test("unplaced domains bound any+any guarantees and hints never create an open face", () => {
  const lib = library("any", "not-passable-hint");
  lib.tiles.push({ ...lib.tiles[1]!, id: "other-hint" },
    { ...lib.tiles[1]!, id: "any-edge", segments: edge(0, "any") });
  const sealed = grid(["right", "other-hint"]);
  assert.notEqual(openFaceRule(lib, sealed, 2, 1)(sealed, [0]), true);
  const possible = grid(["right", "any-edge"]);
  assert.equal(openFaceRule(lib, possible, 2, 1)(possible, [0]), true);
});

test("an unsettled any cell is bounded by possible adjacency asks even beside a hint", () => {
  const lib = library("any", "not-passable-hint");
  lib.tiles[1]!.defaultCellClass = "any";
  lib.tiles.push({ id: "field-a", defaultCellClass: "open", orientations: [0] },
    { id: "field-b", defaultCellClass: "open", orientations: [0] });
  const slots = grid();
  slots[0]!.y = slots[1]!.y = 1;
  // The any cell at (6,6), beside the hut, waits on the slot directly above it.
  slots.push({ x: 1, y: 0, domain: [option("field-a"), option("field-b")], links: [] });
  assert.notEqual(openFaceRule(lib, slots, 2, 2)(slots, [0, 1]), true);
  lib.tiles[3]!.segments = { "h:6,0": { adjacency: "hut" } };
  assert.equal(openFaceRule(lib, slots, 2, 2)(slots, [0, 1]), true);
  delete lib.tiles[3]!.segments;
  lib.tiles[1]!.segments = edge(0, "any");
  assert.equal(openFaceRule(lib, slots, 2, 2)(slots, [0, 1]), true);
});

test("hint validation accepts architectural guidance and fingerprints include its content", () => {
  const original = library("any", "any"), hinted = library("any", "not-passable-hint");
  assert.equal(validateLibrary(hinted, TYPES).valid, true);
  assert.notEqual(libraryFingerprint(original), libraryFingerprint(hinted));
  assert.equal(libraryFingerprint(original), libraryFingerprint(structuredClone(original)));
  const bad = structuredClone(hinted);
  bad.tiles[1]!.segments!["v:0,0"]!.passability = "impassable" as PassabilityPrescription;
  assert.match(validateLibrary(bad, TYPES).errors.join(";"), /malformed passability/);
});

test("hint libraries and their derived views survive JSON, BSON and layout-only saves", () => {
  const lib = library("not-passable-hint", "any");
  lib.tiles[0]!.defaultCellClass = "open";
  const map = generateChainMap("hint-save", layout.params, lib, 4, STUB_ENGINES);
  const expected = mapViews(map, stubCompose).resolved;
  for (const results of [true, false]) for (const bytes of [
    new TextEncoder().encode(chainMapToJson(map, { results })), chainMapToBson(map, { results }),
  ]) {
    const decoded = readChainMap(bytes, undefined, STUB_ENGINES);
    assert.deepEqual(decoded, map);
    assert.deepEqual(mapViews(decoded, stubCompose).resolved, expected);
  }
});
