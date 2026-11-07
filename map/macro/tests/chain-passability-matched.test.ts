import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { libraryFingerprint } from "../src/coding.ts";
import { resolveLibrary, validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary, PassabilityPrescription } from "../src/chain/library.ts";
import { openFaceRule } from "../src/chain/open-face.ts";
import { adjacencyCompatibility, setPieceSeamProblems } from "../src/chain/placement.ts";
import { regions } from "../src/chain/regions.ts";
import { guaranteesPassability, passabilityFits, resolution } from "../src/chain/resolution.ts";
import type { Layout } from "../src/chain/types.ts";
import type { TileOption, WfcGrid } from "../src/wfc.ts";

// Corey's 2026-11-06 answers (17.2.2): `any` fits anything, otherwise like with like; an
// unstated side reads as `any`; `any` meeting `any` passes between regions, not inside one.
const BASE = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const TYPES = new Set(Object.values(BASE.cellClasses).map((entry) => entry.regionType));
const VALUES = ["passable", "any", "not-passable-hint", undefined] as const;
const option = (templateId: string): TileOption => ({ templateId, orientation: 0, difficulty: 0, weight: 1 });
const edge = (line: number, value: PassabilityPrescription | undefined) =>
  value === undefined ? {} : Object.fromEntries(Array.from({ length: 6 }, (_, y) => [`v:${line},${y}`, { passability: value }]));
function library(a: PassabilityPrescription | undefined, b: PassabilityPrescription | undefined, rightClass = "open"): ChainLibrary {
  return { ...BASE, passabilityRules: "matched", tiles: [
    { id: "left", defaultCellClass: "hut", orientations: [0], segments: edge(6, a) },
    { id: "right", defaultCellClass: rightClass, orientations: [0], segments: edge(0, b) },
  ], tileSets: [], setPieces: [], setPieceClasses: [] };
}
const layout: Layout = { seed: "matched", library: "hand", setPieces: [],
  params: { mode: "playground", zoneWidth: 1, zoneHeight: 1, exitCount: 1, contestantCount: 1,
    hunterCount: 1, lootChance: 0, lootTierStep: 0 },
  slots: [{ col: 0, row: 0, design: "left", orientation: 0 }, { col: 1, row: 0, design: "right", orientation: 0 }] };
const grid = (): WfcGrid => [{ x: 0, y: 0, domain: [option("left")], links: [] }, { x: 1, y: 0, domain: [option("right")], links: [] }];

test("matched seams: like with like, any fits anything, and the solver refuses the rest", () => {
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
    assert.deepEqual(regions(resolved, layout.seed).portals.map((p) => p.length), expected ? [6] : [], name);
    const slots = grid();
    assert.equal(openFaceRule(lib, slots, 2, 1)(slots, [0, 1]) === true, expected, name);
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
  // The either-side rule keeps any+any guaranteed inside a region, as before.
  assert.equal(guaranteesPassability("any", "any", "either-side", true), true);
  assert.equal(guaranteesPassability("any", "any", "matched", true), false);
});

test("an unstated class boundary inside a tile passes under matched, and only there", () => {
  // Rows 0-2 hut, rows 3-5 open, with nothing stated between them.
  const tile = { id: "split", defaultCellClass: "hut", orientations: [0], cells: ["......", "......", "......", "oooooo", "oooooo", "oooooo"], legend: { o: "open" } };
  const one: Layout = { ...layout, slots: [{ col: 0, row: 0, design: "split", orientation: 0 }] };
  const matched = { ...BASE, passabilityRules: "matched" as const, tiles: [tile], tileSets: [], setPieces: [], setPieceClasses: [] };
  const segments = resolution(one, matched).segments;
  assert.deepEqual(Array.from({ length: 6 }, (_, x) => segments[`h:${x},3`]?.guarantee), Array(6).fill("guaranteed"));
  assert.equal(segments["h:0,1"], undefined);
  const { passabilityRules: _, ...either } = matched;
  assert.deepEqual(Object.keys(resolution(one, either).segments), []);
});

test("the switch is opt-in: absent keeps a library's fingerprint, and an unknown value is refused", () => {
  const top = { name: "t", version: 3, zonePlan: "diamond", zoneWidth: 1, zoneHeight: 1, cellClasses: BASE.cellClasses,
    tiles: BASE.tiles, tileSets: BASE.tileSets, setPieces: BASE.setPieces, setPieceClasses: BASE.setPieceClasses };
  const plain = resolveLibrary(top, {});
  assert.equal("passabilityRules" in plain, false);
  assert.equal(libraryFingerprint(plain), libraryFingerprint(resolveLibrary(structuredClone(top), {})));
  assert.equal(resolveLibrary({ ...top, passabilityRules: "matched" }, {}).passabilityRules, "matched");
  assert.throws(() => resolveLibrary({ ...top, passabilityRules: "loose" }, {}), /unknown passabilityRules/);
  assert.deepEqual(validateLibrary({ ...BASE, passabilityRules: "matched" }, TYPES).errors, []);
  assert.match(validateLibrary({ ...BASE, passabilityRules: "loose" }, TYPES).errors.join(), /unknown passabilityRules loose/);
});

test("a set piece whose own slots can't meet is reported before placement", () => {
  const lib = library("not-passable-hint", "passable");
  lib.tileSets = [{ id: "left-set", members: ["left"] }, { id: "right-set", members: ["right"] }];
  lib.setPieces = [{ id: "pair", tiles: [{ dx: 0, dy: 0, tileSetId: "left-set" }, { dx: 1, dy: 0, tileSetId: "right-set" }] }];
  lib.setPieceClasses = [{ id: "small", placementRule: "small", quota: 1, setPieces: ["pair"] }];
  assert.deepEqual(setPieceSeamProblems(lib), ["set piece pair: slots 0,0 and 1,0 have no members whose sides fit"]);
  // A member that fits is enough, and either-side libraries are never checked.
  lib.tiles.push({ ...lib.tiles[1]!, id: "right-any", segments: edge(0, "any") });
  lib.tileSets[1]!.members.push("right-any");
  assert.deepEqual(setPieceSeamProblems(lib), []);
  const { passabilityRules: _, ...either } = library("not-passable-hint", "passable");
  assert.deepEqual(setPieceSeamProblems({ ...either, tileSets: lib.tileSets, setPieces: lib.setPieces, setPieceClasses: lib.setPieceClasses }), []);
});

test("a design stated fillable: false is left to set pieces, as weight 0 still is", async () => {
  const { placement } = await import("../src/chain/placement.ts");
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
