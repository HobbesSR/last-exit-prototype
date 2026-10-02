import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHAIN_LIBRARY_VERSION, validateLibrary } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/chain-library.json", import.meta.url), "utf8")) as ChainLibrary;
const TYPES = new Set(["open-field", "hut", "arrival"]);
const copy = (): ChainLibrary => structuredClone(FIXTURE);
const refusal = (library: unknown, label: RegExp) => {
  const result = validateLibrary(library, TYPES);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("; "), label);
};

test("fixture is valid and the chain has its own version", () => {
  assert.equal(CHAIN_LIBRARY_VERSION, 1);
  assert.deepEqual(validateLibrary(FIXTURE, TYPES), { valid: true, errors: [] });
  refusal({ ...copy(), version: 2 }, /unsupported version/);
});

test("cell class registry is total and each entry names a known region type", () => {
  const undeclared = copy();
  undeclared.tiles[0]!.legend!.h = "missing";
  refusal(undeclared, /undeclared cell class missing/);
  const badType = copy();
  badType.cellClasses.hut!.regionType = "unknown";
  refusal(badType, /cell class hut: names no known region type/);
  const reserved = copy();
  reserved.cellClasses.any = { regionType: "hut" };
  refusal(reserved, /reserved class any/);
});

test("malformed adjacency and passability are refused separately", () => {
  const badAdjacency = copy();
  badAdjacency.tiles[0]!.segments!["v:6,2"]!.adjacency = "missing";
  refusal(badAdjacency, /malformed adjacency v:6,2/);
  const outside = copy();
  outside.tiles[0]!.segments!["v:6,2"]!.adjacency = "";
  refusal(outside, /malformed adjacency v:6,2/);
  const badPassability = copy();
  badPassability.tiles[0]!.segments!["v:3,4"]!.passability = "impassable" as "any";
  refusal(badPassability, /malformed passability v:3,4/);
  const badAddress = copy();
  badAddress.tiles[0]!.segments!["v:7,1"] = { passability: "any" };
  refusal(badAddress, /malformed segment prescription v:7,1/);
});

test("adjacency is allowed only on a tile perimeter segment", () => {
  const library = copy();
  library.tiles[0]!.segments!["v:3,2"]!.adjacency = "hut";
  refusal(library, /adjacency on non-perimeter segment v:3,2/);
});

test("a short passable run wholly inside a tile is refused, grouped by class", () => {
  const one = copy();
  delete one.tiles[0]!.segments!["v:3,3"];
  refusal(one, /short passable run v:3,2\.\.2/);

  const differentClass = copy();
  differentClass.tiles[0]!.legend!.a = "arrival";
  differentClass.tiles[0]!.cells![3] = "aaa" + "hhh";
  refusal(differentClass, /short passable run v:3,2\.\.2 for classes .*open/);
  refusal(differentClass, /short passable run v:3,3\.\.3 for classes arrival\|hut/);

  const edge = copy();
  edge.tiles[0]!.segments = { "v:3,0": { passability: "passable" } };
  assert.deepEqual(validateLibrary(edge, TYPES).errors, []);
  assert.deepEqual(validateLibrary(one, TYPES, 1).errors, []);
});

test("staggered class changes cannot hide a one-segment portal", () => {
  const library = copy();
  library.cellClasses.p = { regionType: "hut" };
  library.cellClasses.q = { regionType: "hut" };
  library.tiles[0]!.legend = { P: "p", H: "hut", Q: "q" };
  library.tiles[0]!.cells = ["......", "..PH..", "..PH..", "...H..", "...Q..", "...Q.."];
  library.tiles[0]!.segments = Object.fromEntries(
    [1, 2, 3, 4, 5].map((y) => [`v:3,${y}`, { passability: "passable" }]),
  );
  refusal(library, /short passable run v:3,3\.\.3 for classes hut\|open/);
});

test("any beside open resolves away before the interior run check", () => {
  const library = copy();
  library.tiles[0]!.legend!.a = "any";
  library.tiles[0]!.cells = Array.from({ length: 6 }, () => "aaa...");
  library.tiles[0]!.segments = { "v:3,2": { passability: "passable" } };
  assert.deepEqual(validateLibrary(library, TYPES).errors, []);
});

test("a perimeter any cell defers its portal check until placement resolves its class", () => {
  const library = copy();
  library.tiles[0]!.legend = { a: "any", h: "hut" };
  library.tiles[0]!.cells = ["......", "......", "ah....", "......", "......", "......"];
  library.tiles[0]!.segments = { "v:1,2": { passability: "passable" } };
  assert.deepEqual(validateLibrary(library, TYPES).errors, []);
});

test("a written any and unstated passability stay distinct", () => {
  const tile = FIXTURE.tiles[0]!;
  assert.deepEqual(tile.segments!["v:3,4"], { passability: "any" });
  assert.equal(tile.segments!["v:3,5"], undefined);
  const library = copy();
  library.tiles[0]!.segments!["v:3,2"]!.passability = "any";
  refusal(library, /short passable run v:3,3\.\.3/);
});

test("set piece classes need a rule, quota and valid feature counts", () => {
  const rule = copy();
  delete (rule.setPieceClasses[0] as Partial<typeof rule.setPieceClasses[number]>).placementRule;
  refusal(rule, /missing or unknown placement rule/);
  const count = copy();
  count.setPieceClasses[0]!.features!.spawn = 0;
  refusal(count, /feature spawn count must be a positive integer/);
  const param = copy();
  param.setPieceClasses[0]!.features!.exit = "missing" as "exitCount";
  refusal(param, /feature exit count must be a positive integer or exitCount/);
  // Counts have no ceiling: how many a builder can site is the builder's concern.
  const many = copy();
  many.setPieceClasses[0]!.features!.spawn = 1000;
  Object.values(many.cellClasses)[0]!.features = { exit: 1000 };
  assert.deepEqual(validateLibrary(many, TYPES).errors, []);
});

test("tile sets and set piece classes are sets: a repeated member is refused", () => {
  const tileSet = copy();
  tileSet.tileSets[0]!.members.push("half-hut");
  refusal(tileSet, /tile set one: repeated member half-hut/);
  const setPieceClass = copy();
  setPieceClass.setPieceClasses[0]!.setPieces.push("entry");
  refusal(setPieceClass, /set piece class start: repeated set piece entry/);
});

test("a set piece slot's fixed orientation must suit some member of its tile set", () => {
  const unsuited = copy();
  unsuited.tiles[0]!.orientations = [0];
  unsuited.setPieces[0]!.tiles[0]!.orientation = 90;
  refusal(unsuited, /set piece entry: slot 0 orientation 90 suits no member of tile set one/);
  const suited = copy();
  suited.setPieces[0]!.tiles[0]!.orientation = 90;
  assert.deepEqual(validateLibrary(suited, TYPES), { valid: true, errors: [] });
});

test("a primary region class must be declared", () => {
  const library = copy();
  library.setPieces[0]!.primaryRegionClass = "missing";
  refusal(library, /primaryRegionClass is not declared/);
  library.setPieces[0]!.primaryRegionClass = "any";
  refusal(library, /primaryRegionClass is not declared/);
});

test("feature promises are not checked for delivery at library load", () => {
  const library = copy();
  library.cellClasses.arrival = { regionType: "arrival" };
  assert.deepEqual(validateLibrary(library, TYPES).errors, []);
});

test("retired and unknown schema fields are refused", () => {
  const oldTile = copy();
  (oldTile.tiles[0] as unknown as Record<string, unknown>).walls = [];
  refusal(oldTile, /tile half-hut: unknown field walls/);
  const oldSetPiece = copy();
  (oldSetPiece.setPieces[0] as unknown as Record<string, unknown>).category = "start";
  refusal(oldSetPiece, /set piece entry: unknown field category/);
  const topLevel = copy();
  (topLevel as unknown as Record<string, unknown>).legacy = true;
  refusal(topLevel, /library: unknown field legacy/);
});

test("tiers, segment addresses and set piece slots have unambiguous bounds", () => {
  const tier = copy();
  tier.tiles[0]!.eligibleTiers = [0];
  refusal(tier, /malformed eligibleTiers/);
  const address = copy();
  address.tiles[0]!.segments!["v:03,2"] = { passability: "any" };
  refusal(address, /malformed segment prescription v:03,2/);
  const slot = copy();
  slot.setPieces[0]!.tiles.push(structuredClone(slot.setPieces[0]!.tiles[0]!));
  refusal(slot, /duplicate slot 0,0/);
});
