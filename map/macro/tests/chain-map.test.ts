/**
 * 51 step 9: the finished map, its one accessor, and saving. A decoded map equals the
 * generated one, a save of the Layout alone rebuilds identical results, and every version
 * mismatch is refused by name. The game's engines are stubbed (`chain-stub.ts`); the root
 * test `tests/map-container.test.js` runs the same round trip with the game's own.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeArtifact } from "../src/artifact.ts";
import { briefs, chainZones } from "../src/chain/briefs.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import { generateChainMap, mapViews, MACRO_VERSION } from "../src/chain/map.ts";
import { measurement } from "../src/chain/measurement.ts";
import { proof } from "../src/chain/proof.ts";
import { regions } from "../src/chain/regions.ts";
import { resolution } from "../src/chain/resolution.ts";
import { CHAIN_WIRE_VERSION, chainMapToBson, chainMapToJson, decodeChainMap, encodeChainMap, readChainMap } from "../src/chain/saving.ts";
import type { ChainMap, ChainParams, MapEngines } from "../src/chain/types.ts";
import { STUB_ENGINES, stubBuild, stubCompose } from "./chain-stub.ts";

const LIBRARY = JSON.parse(readFileSync(new URL("./fixtures/chain-placement-library.json", import.meta.url), "utf8")) as ChainLibrary;
const GAME: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
const SEEDS = ["placement-1", "placement-2", "placement-3", "placement-4"];
const CELL_SIZE = 4;
/** Stub results with something in every field, so a round trip that dropped one would show. */
const ENGINES: MapEngines = {
  ...STUB_ENGINES,
  build: (brief) => ({ ...stubBuild(brief), elements: [{ kind: "rock", x: brief.cells[0]!.x, y: brief.cells[0]!.y, r: 0.5 }],
    loot: [{ x: brief.cells[0]!.x * CELL_SIZE, y: brief.cells[0]!.y * CELL_SIZE, tier: 1 }], manifest: { rocks: 1 } }),
};
const maps = new Map(SEEDS.map((seed) => [seed, generateChainMap(seed, GAME, LIBRARY, CELL_SIZE, ENGINES)]));
const MAP = maps.get(SEEDS[0]!)!;
const encode = (map: ChainMap, results = true) => JSON.parse(chainMapToJson(map, { results }));

test("the map holds the Layout, the results and the library, and the accessor reads every view from them", () => {
  assert.deepEqual(Object.keys(MAP).sort(), ["build", "cellSize", "layout", "library", "results"]);
  const views = mapViews(MAP, stubCompose);
  const resolved = resolution(MAP.layout, LIBRARY), found = regions(resolved, MAP.layout.seed);
  const given = briefs(MAP.layout, found, chainZones(MAP.layout.params), LIBRARY, CELL_SIZE);
  assert.deepEqual(views.resolved, resolved);
  assert.deepEqual(views.regions, found);
  assert.deepEqual(views.proof, proof(found));
  assert.deepEqual(views.briefs, given);
  assert.deepEqual(MAP.results.map((result) => result.brief), given);
  assert.deepEqual(views.report, measurement(stubCompose(MAP.results), proof(found), MAP.layout, LIBRARY));
  assert.deepEqual(views.report.defects, []);
  // Each view is computed once per accessor, and the map itself gains no fields.
  assert.equal(views.regions, views.regions);
  assert.deepEqual(Object.keys(MAP).sort(), ["build", "cellSize", "layout", "library", "results"]);
  assert.throws(() => mapViews(MAP).built, /the built map needs the game's compose/);
});

test("a decoded map equals the generated one, in JSON and in BSON", () => {
  for (const [seed, map] of maps) {
    assert.deepEqual(decodeChainMap(encode(map), LIBRARY), map, seed);
    assert.deepEqual(readChainMap(chainMapToBson(map), LIBRARY), map, seed);
    assert.deepEqual(readChainMap(new TextEncoder().encode(chainMapToJson(map)), LIBRARY), map, seed);
  }
});

test("views are never saved: the wire form holds the Layout and the results less their briefs", () => {
  const wire = encode(MAP);
  assert.deepEqual(Object.keys(wire).sort(), ["build", "format", "layout", "strings", "wire"]);
  assert.equal(wire.wire, CHAIN_WIRE_VERSION);
  assert.equal(wire.layout.macro, MACRO_VERSION);
  assert.deepEqual(Object.keys(wire.build).sort(), ["cellSize", "format", "results", "version"]);
  assert.deepEqual(Object.keys(wire.build.results[0]).sort(), ["coreElements", "elements", "loot", "manifest"]);
});

test("a save of the Layout alone rebuilds identical results", () => {
  for (const [seed, map] of maps) {
    const wire = encode(map, false);
    assert.equal(wire.build.results, undefined, seed);
    assert.equal(wire.build.version, ENGINES.version, seed);
    assert.deepEqual(decodeChainMap(wire, LIBRARY, ENGINES), map, seed);
    assert.deepEqual(readChainMap(chainMapToBson(map, { results: false }), LIBRARY, ENGINES), map, seed);
  }
  assert.throws(() => decodeChainMap(encode(MAP, false), LIBRARY), /holds the Layout alone; rebuilding its results needs the game's engines/);
});

test("every version mismatch is refused by name", () => {
  const wire = encode(MAP);
  assert.throws(() => decodeChainMap({ ...wire, wire: 4 }, LIBRARY),
    /wire version 4 isn't a chain map: it holds a map from mapgen's old generators/);
  assert.throws(() => decodeChainMap({ ...wire, wire: 1 }, LIBRARY), /wire version 1 isn't a chain map/);
  assert.throws(() => decodeChainMap({ ...wire, wire: 5 }, LIBRARY),
    /wire version 5 isn't a chain map: its params have no contestantCount or hunterCount/);
  assert.throws(() => decodeChainMap({ ...wire, wire: CHAIN_WIRE_VERSION + 1 }, LIBRARY), /unsupported wire version 7/);
  assert.throws(() => decodeChainMap({ ...wire, layout: { ...wire.layout, macro: MACRO_VERSION + 1 } }, LIBRARY),
    /placed by macro version 2, and this reader's stages are version 1/);
  assert.throws(() => decodeChainMap(wire, { ...LIBRARY, setPieces: LIBRARY.setPieces.slice(1) }), /made with a different library/);
  assert.throws(() => decodeChainMap({ ...wire, build: { ...wire.build, format: "region-1" } }, LIBRARY), /its results are region-1/);
  assert.throws(() => decodeChainMap(encode(MAP, false), LIBRARY, { ...ENGINES, version: "stub-2" }),
    /its results were built by strategies stub-1, not stub-2/);
  // Results that are saved aren't rebuilt, so other engines may read them.
  assert.deepEqual(decodeChainMap(wire, LIBRARY, { ...ENGINES, version: "stub-2" }), MAP);
  // The old generators' reader names the chain's version rather than calling it unknown.
  assert.throws(() => decodeArtifact(wire), /wire version 6 is a generation chain map; read it with decodeChainMap/);
  assert.throws(() => decodeArtifact({ ...wire, wire: 5 }), /wire version 5 is a generation chain map/);
});

test("results that don't match their layout are refused, not saved", () => {
  const moved = { ...MAP, results: MAP.results.map((result, i) => i ? result : { ...result, brief: { ...result.brief, seed: result.brief.seed + 1 } }) };
  assert.throws(() => encodeChainMap(moved), /doesn't hold the brief its layout gives/);
  assert.throws(() => encodeChainMap({ ...MAP, results: MAP.results.slice(1) }), /holds \d+ results, but its layout gives \d+ briefs/);
  // A save of the Layout alone doesn't read them.
  assert.doesNotThrow(() => encodeChainMap(moved, { results: false }));
  const wire = encode(MAP);
  assert.throws(() => decodeChainMap({ ...wire, build: { ...wire.build, results: wire.build.results.slice(1) } }, LIBRARY),
    /the save holds \d+ results, but its layout gives \d+ briefs/);
});

test("a saved result can't override its derived brief or its version", () => {
  const wire = encode(MAP), first = wire.build.results[0];
  const forged = (extra: object) => ({ ...wire, build: { ...wire.build, results: [{ ...first, ...extra }, ...wire.build.results.slice(1)] } });
  assert.throws(() => decodeChainMap(forged({ brief: { ...MAP.results[0]!.brief, id: "forged" } }), LIBRARY),
    new RegExp(`region ${MAP.results[0]!.brief.id}'s saved result holds brief, which a save never holds`));
  assert.throws(() => decodeChainMap(forged({ version: "region-3" }), LIBRARY), /saved result holds version, which a save never holds/);
});

test("a result whose brief is equal but built in another key order is saved", () => {
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  const results = MAP.results.map((result) => ({ ...result, brief: reorder(result.brief) as typeof result.brief }));
  assert.notEqual(JSON.stringify(results[0]!.brief), JSON.stringify(MAP.results[0]!.brief));
  assert.deepEqual(decodeChainMap(encodeChainMap({ ...MAP, results }), LIBRARY), MAP);
});
