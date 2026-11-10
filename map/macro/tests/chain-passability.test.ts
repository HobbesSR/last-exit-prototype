import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { libraryFingerprint } from "../src/coding.ts";
import { resolveLibrary, validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary, PassabilityPrescription } from "../src/chain/library.ts";
import { openFaceRule } from "../src/chain/open-face.ts";
import { generateChainMap, mapViews } from "../src/chain/map.ts";
import { adjacencyCompatibility, placement, setPieceSeamProblems } from "../src/chain/placement.ts";
import { chainMapToBson, chainMapToJson, readChainMap } from "../src/chain/saving.ts";
import { portalViolations, regions } from "../src/chain/regions.ts";
import { guaranteesPassability, passabilityFits, resolution } from "../src/chain/resolution.ts";
import type { Layout } from "../src/chain/types.ts";
import type { TileOption, WfcGrid } from "../src/wfc.ts";
import { STUB_ENGINES, stubCompose } from "./chain-stub.ts";

// Corey's 2026-11-06 answers (17.2.2), the only passability rule (51.4): `any` fits anything,
// otherwise like with like; an unstated side reads as `any`; `any` meeting `any` passes between
// regions, not inside one.
const BASE = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const TYPES = new Set(Object.values(BASE.cellClasses).map((entry) => entry.regionType));
const VALUES = ["passable", "any", "not-passable-hint", undefined] as const;
const option = (templateId: string): TileOption => ({ templateId, orientation: 0, difficulty: 0, weight: 1 });
const edge = (line: number, value: PassabilityPrescription | undefined, length = 6) =>
  value === undefined ? {} : Object.fromEntries(Array.from({ length }, (_, y) => [`v:${line},${y}`, { passability: value }]));
function library(a: PassabilityPrescription | undefined, b: PassabilityPrescription | undefined, rightClass = "open", length = 6): ChainLibrary {
  return { ...BASE, tiles: [
    { id: "left", defaultCellClass: "hut", orientations: [0], segments: edge(6, a, length) },
    { id: "right", defaultCellClass: rightClass, orientations: [0], segments: edge(0, b, length) },
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

test("seams: like with like, any fits anything, and the solver refuses the rest", () => {
  // Rows and columns follow VALUES; null marks a pair placement refuses.
  const BETWEEN = [[true, true, null, true], [true, true, false, true], [null, false, false, false], [true, true, false, true]];
  for (const [i, a] of VALUES.entries()) for (const [j, b] of VALUES.entries()) {
    const lib = library(a, b), expected = BETWEEN[i]![j]!, name = `${a}/${b}`;
    assert.equal(adjacencyCompatibility(lib)(option("left"), "E", option("right")), expected !== null, name);
    assert.equal(passabilityFits(a, b), expected !== null, name);
    if (expected === null) { assert.throws(() => resolution(layout, lib), /placement refuses/, name); continue; }
    const resolved = resolution(layout, lib), segment = resolved.segments["v:6,0"];
    // An unstated seam between two regions is listed and guaranteed, with its provenance.
    assert.deepEqual(segment, { guarantee: expected ? "guaranteed" : "none", stated: [a ?? "unstated", b ?? "unstated"] }, name);
    const found = regions(resolved, layout.seed);
    assert.deepEqual(found.portals.map((p) => p.length), expected ? [6] : [], name);
    assert.deepEqual(portalViolations(found), [], name);
    const slots = grid();
    assert.equal(openFaceRule(lib, slots, 2, 1)(slots, [0, 1]) === true, expected, name);
    // Each outward authored prescription retains provenance but promises nothing.
    const outside = resolution({ ...layout, slots: layout.slots.slice(0, 1) }, lib).segments["v:6,0"];
    if (a !== undefined) assert.deepEqual(outside, { guarantee: "none", stated: [a, null] }, name);
  }
});

test("inside one region, only an explicit passable is guaranteed", () => {
  for (const a of VALUES) for (const b of VALUES) {
    if (!passabilityFits(a, b)) continue;
    const segment = resolution(layout, library(a, b, "hut")).segments["v:6,0"];
    const expected = a === "passable" || b === "passable";
    if (a === undefined && b === undefined) assert.equal(segment, undefined);
    else assert.equal(segment?.guarantee, expected ? "guaranteed" : "none", `${a}/${b}`);
  }
  assert.equal(guaranteesPassability("any", "any", true), false);
  assert.equal(guaranteesPassability("any", "any", false), true);
});

test("an unstated class boundary inside a tile passes", () => {
  // Rows 0-2 hut, rows 3-5 open, with nothing stated between them.
  const tile = { id: "split", defaultCellClass: "hut", orientations: [0], cells: ["......", "......", "......", "oooooo", "oooooo", "oooooo"], legend: { o: "open" } };
  const one: Layout = { ...layout, slots: [{ col: 0, row: 0, design: "split", orientation: 0 }] };
  const segments = resolution(one, { ...BASE, tiles: [tile], tileSets: [], setPieces: [], setPieceClasses: [] }).segments;
  assert.deepEqual(Array.from({ length: 6 }, (_, x) => segments[`h:${x},3`]?.guarantee), Array(6).fill("guaranteed"));
  assert.equal(segments["h:0,1"], undefined);
});

test("emergent crossings shorter than MIN_PORTAL_LENGTH demote to none, and are not refused (#893)", () => {
  const notchTile = {
    id: "notch", defaultCellClass: "open", cells: [".....H", "......", "......", "......", "......", "......"],
    legend: { H: "hut" }, orientations: [0],
  };
  const plainTile = { id: "plain", defaultCellClass: "rubble", orientations: [0] };
  const lib: ChainLibrary = { ...BASE, tiles: [notchTile, plainTile], tileSets: [], setPieces: [], setPieceClasses: [] };
  const testLayout: Layout = {
    seed: "notch-test", library: "hand", setPieces: [],
    params: layout.params,
    slots: [{ col: 0, row: 0, design: "notch", orientation: 0 }, { col: 1, row: 0, design: "plain", orientation: 0 }],
  };
  const resolved = resolution(testLayout, lib);
  assert.equal(resolved.segments["v:6,0"]?.guarantee, "none");
  assert.equal(resolved.segments["v:6,1"]?.guarantee, "guaranteed");
  assert.equal(portalViolations(regions(resolved, testLayout.seed)).length, 0);

  const testGrid: WfcGrid = [
    { x: 0, y: 0, domain: [option("notch")], links: [] },
    { x: 1, y: 0, domain: [option("plain")], links: [] },
  ];
  const reasons: string[] = [];
  openFaceRule(lib, testGrid, 2, 1, (r) => reasons.push(r))(testGrid, [0, 1]);
  assert.equal(reasons.some((r) => r.includes("shorter than a hunter")), false);
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

test("a library or saved map that omits the rules or states a retired one is refused, saying what to state (#922)", () => {
  const top = { name: "t", version: 3, zonePlan: "diamond", zoneWidth: 1, zoneHeight: 1, cellClasses: BASE.cellClasses,
    tiles: BASE.tiles, tileSets: BASE.tileSets, setPieces: BASE.setPieces, setPieceClasses: BASE.setPieceClasses,
    passabilityRules: "matched", fitPlacedSetPieces: true };
  const stated = resolveLibrary(top, {});
  assert.equal(stated.passabilityRules, "matched");
  assert.equal(stated.fitPlacedSetPieces, true);
  assert.deepEqual(validateLibrary(BASE, TYPES).errors, []);
  const { passabilityRules: _r, ...noRules } = top, { fitPlacedSetPieces: _f, ...noFit } = top;
  for (const [lib, reason] of [
    [noRules, /states no passabilityRules.*State "passabilityRules": "matched"/],
    [{ ...top, passabilityRules: "either-side" }, /either-side, which is retired.*State "passabilityRules": "matched"/],
    [{ ...top, passabilityRules: "loose" }, /unknown passabilityRules loose/],
    [noFit, /states no fitPlacedSetPieces.*State "fitPlacedSetPieces": true/],
    [{ ...top, fitPlacedSetPieces: false }, /states fitPlacedSetPieces false.*State "fitPlacedSetPieces": true/],
  ] as const) {
    assert.throws(() => resolveLibrary(lib, {}), reason);
    assert.match(validateLibrary({ ...lib, zoneWidth: 12, zoneHeight: 6 }, TYPES).errors.join(), reason);
  }
  // A saved map embeds its library, so a map saved under a retired rule is refused on read.
  const map = generateChainMap("retired-save", layout.params, library("passable", "any"), 4, STUB_ENGINES);
  const wire = JSON.parse(chainMapToJson(map));
  delete wire.library.passabilityRules;
  assert.throws(() => readChainMap(new TextEncoder().encode(JSON.stringify(wire)), undefined, STUB_ENGINES),
    /invalid saved library: library: states no passabilityRules/);
});

test("a set piece whose own slots can't meet is reported before placement", () => {
  const lib = library("not-passable-hint", "passable");
  lib.tileSets = [{ id: "left-set", members: ["left"] }, { id: "right-set", members: ["right"] }];
  lib.setPieces = [{ id: "pair", tiles: [{ dx: 0, dy: 0, tileSetId: "left-set" }, { dx: 1, dy: 0, tileSetId: "right-set" }] }];
  lib.setPieceClasses = [{ id: "small", placementRule: "small", quota: 1, setPieces: ["pair"] }];
  assert.deepEqual(setPieceSeamProblems(lib), ["set piece pair: slots 0,0 and 1,0 have no members whose sides fit"]);
  // A member that fits is enough.
  lib.tiles.push({ ...lib.tiles[1]!, id: "right-any", segments: edge(0, "any") });
  lib.tileSets[1]!.members.push("right-any");
  assert.deepEqual(setPieceSeamProblems(lib), []);
});

test("a design stated fillable: false is left to set pieces", () => {
  const params = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
  const inSetPieces = (layout: Layout) => new Set(layout.setPieces.flatMap((instance) => instance.slots.map((s) => `${s.col},${s.row}`)));
  const fillDesigns = (lib: ChainLibrary) => {
    const layout = placement("fillable", params, lib), pieces = inSetPieces(layout);
    return new Set(layout.slots.filter((s) => !pieces.has(`${s.col},${s.row}`)).map((s) => s.design));
  };
  assert.ok(fillDesigns(BASE).has("borderland"));
  const flagged = { ...BASE, tiles: BASE.tiles.map((t) => t.id === "borderland" ? { ...t, fillable: false } : t) };
  assert.deepEqual(validateLibrary(flagged, TYPES).errors, []);
  assert.equal(fillDesigns(flagged).has("borderland"), false);
  assert.match(validateLibrary({ ...BASE, tiles: [{ ...BASE.tiles[0]!, fillable: "no" }, ...BASE.tiles.slice(1)] }, TYPES).errors.join(), /malformed fillable/);
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
