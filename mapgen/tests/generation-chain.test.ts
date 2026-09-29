/**
 * docs/archive/pre-integration/DESIGN_DECISIONS.md "The generation chain" (#65, #66, #67): one seed decides
 * the whole map through every step, the layout alone regenerates what follows
 * it, and each step is a pure function of its inputs. No generator change
 * rides on this file; a failure here is a determinism bug, not a flaky test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { artifactFromBson, artifactToBson } from "../src/artifact.ts";
import { DEFAULT_LIBRARY, deriveRegions, deriveStructure, generateInteriors, generateMap } from "../src/core.ts";
import { generatePlannedMap } from "../src/plan/compose.ts";
import type { Library } from "../src/types.ts";
import { builderLibrary } from "../tools/sweep.mts";

const builders = builderLibrary();
const SMALL = { mode: "playground" as const, zoneWidth: 4, zoneHeight: 2 };

// The eight seeds checked by hand on 2026-09-27, alternating the two libraries.
const SEEDS = Array.from({ length: 8 }, (_, i) => `det-${i}`);
const V2_CASES: Array<{ name: string; seed: string; library: Library }> = SEEDS.map((seed, i) =>
  i % 2 === 0
    ? { name: "default library", seed, library: DEFAULT_LIBRARY }
    : { name: "builder-bound library", seed, library: builders },
);
const v2 = V2_CASES.map((c) => ({ ...c, map: generateMap(c.seed, {}, c.library) }));

test("the same seed gives the same V2 map", () => {
  for (const { name, seed, library, map } of v2)
    assert.deepEqual(generateMap(seed, {}, library), map, `${name}, seed ${seed}`);
});

test("the same seed gives the same planned map", () => {
  for (const seed of SEEDS)
    assert.deepEqual(generatePlannedMap(seed, SMALL), generatePlannedMap(seed, SMALL), `seed ${seed}`);
});

// Compared with the interiors read back, not the in-memory ones, so a wire
// change that alters what's stored can't pass unnoticed.
test("a saved layout alone regenerates the stored interiors", () => {
  for (const { name, seed, library, map } of v2) {
    const back = artifactFromBson(artifactToBson(map), library);
    const structure = deriveStructure(back.layout!, library);
    assert.ok(structure, `${name}, seed ${seed}: the decoded layout has a structure`);
    const { interiors } = generateInteriors(back.layout!, structure, deriveRegions(back.layout!, structure, library));
    assert.deepEqual(interiors, back.interiors, `${name}, seed ${seed}`);
  }
});

test("deriveStructure is a pure function of the layout", () => {
  for (const { name, seed, library, map } of v2) {
    const layout = structuredClone(map.layout!);
    const first = deriveStructure(map.layout!, library);
    assert.deepEqual(deriveStructure(map.layout!, library), first, `${name}, seed ${seed}`);
    assert.deepEqual(map.layout, layout, `${name}, seed ${seed}: the layout is unchanged`);
  }
});

test("deriveRegions is a pure function of the layout and structure", () => {
  for (const { name, seed, library, map } of v2) {
    const structure = deriveStructure(map.layout!, library)!;
    const layoutBefore = structuredClone(map.layout!);
    const structureBefore = structuredClone(structure);
    const first = deriveRegions(map.layout!, structure, library);
    assert.deepEqual(deriveRegions(map.layout!, structure, library), first, `${name}, seed ${seed}`);
    assert.deepEqual(map.layout, layoutBefore, `${name}, seed ${seed}: layout`);
    assert.deepEqual(structure, structureBefore, `${name}, seed ${seed}: structure`);
  }
});

// Openings are read off the grid as earlier builders left it, so they stay out
// until #68 takes them from the tile designs.
const REGION_INPUT_KEYS = ["candidates", "cellClass", "cells", "corridors", "regionId", "rule", "seed"];

test("the region inputs are plain data holding nothing micro writes", () => {
  for (const { name, seed, library, map } of v2) {
    const structure = deriveStructure(map.layout!, library)!;
    const regions = deriveRegions(map.layout!, structure, library);
    assert.ok(regions.blocks.length > 0, `${name}, seed ${seed}: some block is built`);
    for (const block of regions.blocks)
      assert.deepEqual(Object.keys(block).sort(), REGION_INPUT_KEYS, `${name}, seed ${seed}: ${block.regionId}`);
    // structuredClone refuses functions, so a mask or a grid reader can't hide here.
    assert.deepEqual(structuredClone(regions), regions, `${name}, seed ${seed}: plain data`);
  }
});

test("generateInteriors leaves its layout, structure and region inputs unchanged", () => {
  for (const { name, seed, library, map } of v2) {
    const structure = deriveStructure(map.layout!, library)!;
    const regions = deriveRegions(map.layout!, structure, library);
    const layoutBefore = structuredClone(map.layout!);
    const structureBefore = structuredClone(structure);
    const regionsBefore = structuredClone(regions);
    generateInteriors(map.layout!, structure, regions);
    assert.deepEqual(map.layout, layoutBefore, `${name}, seed ${seed}: layout`);
    assert.deepEqual(structure, structureBefore, `${name}, seed ${seed}: structure`);
    assert.deepEqual(regions, regionsBefore, `${name}, seed ${seed}: region inputs`);
  }
});
