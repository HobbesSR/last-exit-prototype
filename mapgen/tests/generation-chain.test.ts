/**
 * docs/DESIGN_DECISIONS.md "The generation chain" (#65, #66): one seed decides
 * the whole map through every step, the layout alone regenerates what follows
 * it, and each step is a pure function of its inputs. No generator change
 * rides on this file; a failure here is a determinism bug, not a flaky test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { artifactFromBson, artifactToBson } from "../src/artifact.ts";
import { DEFAULT_LIBRARY, deriveStructure, generateInteriors, generateMap } from "../src/core.ts";
import { generatePlannedMap } from "../src/plan/compose.ts";
import type { Library } from "../src/types.ts";
import { builderLibrary } from "../tools/sweep.mts";

const builders = builderLibrary();
const SMALL = { mode: "playground" as const, zoneWidth: 4, zoneHeight: 2 };

// A default-size V2 map with builders takes seconds, so each library gets few seeds.
const V2_CASES: Array<{ name: string; seed: string; library: Library }> = [
  { name: "default library", seed: "det-0", library: DEFAULT_LIBRARY },
  { name: "default library", seed: "det-2", library: DEFAULT_LIBRARY },
  { name: "builder-bound library", seed: "det-1", library: builders },
  { name: "builder-bound library", seed: "det-3", library: builders },
];
const v2 = V2_CASES.map((c) => ({ ...c, map: generateMap(c.seed, {}, c.library) }));

test("the same seed gives the same V2 map", () => {
  for (const { name, seed, library, map } of v2)
    assert.deepEqual(generateMap(seed, {}, library), map, `${name}, seed ${seed}`);
});

test("the same seed gives the same planned map", () => {
  for (const seed of ["det-0", "det-1", "det-2", "det-3"])
    assert.deepEqual(generatePlannedMap(seed, SMALL), generatePlannedMap(seed, SMALL), `seed ${seed}`);
});

test("a saved layout alone regenerates the stored interiors", () => {
  for (const { name, seed, library, map } of v2) {
    const back = artifactFromBson(artifactToBson(map), library);
    const structure = deriveStructure(back.layout!, library);
    assert.ok(structure, `${name}, seed ${seed}: the decoded layout has a structure`);
    const { interiors } = generateInteriors(back.layout!, structure, library);
    assert.deepEqual(interiors, map.interiors, `${name}, seed ${seed}`);
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

test("generateInteriors leaves its layout and structure unchanged", () => {
  for (const { name, seed, library, map } of v2) {
    const structure = deriveStructure(map.layout!, library)!;
    const layoutBefore = structuredClone(map.layout!);
    const structureBefore = structuredClone(structure);
    generateInteriors(map.layout!, structure, library);
    assert.deepEqual(map.layout, layoutBefore, `${name}, seed ${seed}: layout`);
    assert.deepEqual(structure, structureBefore, `${name}, seed ${seed}: structure`);
  }
});
