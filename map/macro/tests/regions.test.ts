import assert from "node:assert/strict";
import test from "node:test";
import { generateRegion, validateCellClass } from "../src/regions.ts";
import type { RegionInput } from "../src/types.ts";

const at = (cellIndex: number, x: number, lootChance: number) => ({
  cellIndex,
  x,
  y: 2,
  lootChance,
});
const input: RegionInput = {
  seed: "region-seed",
  cellClass: "yard",
  budget: 3,
  candidates: [at(8, 8, 1), at(2, 2, 1), at(5, 5, 1), at(11, 11, 1)],
};

test("scatter is deterministic and independent of candidate order", () => {
  const expected = generateRegion(input);
  const reordered = generateRegion({
    ...input,
    candidates: [...input.candidates].reverse(),
  });
  assert.deepEqual(reordered, expected);
  assert.deepEqual(
    expected.spawns.map((spawn) => spawn.cellIndex),
    [2, 5, 8],
  );
});

test("budget and the macro loot chance constrain loot slots", () => {
  assert.deepEqual(generateRegion({ ...input, budget: 0 }).spawns, []);
  assert.deepEqual(
    generateRegion({
      ...input,
      candidates: input.candidates.map((c) => ({ ...c, lootChance: 0 })),
    }).spawns,
    [],
  );
  assert.equal(
    generateRegion({ ...input, budget: 99 }).spawns.length,
    input.candidates.length,
  );
});

test("loot density follows the candidate, so a region may span tier zones", () => {
  // Two halves of one region under different zones: only the rich half spawns.
  const mixed = generateRegion({
    ...input,
    budget: 99,
    candidates: [at(2, 2, 0), at(5, 5, 0), at(8, 8, 1), at(11, 11, 1)],
  });
  assert.deepEqual(
    mixed.spawns.map((s) => s.cellIndex),
    [8, 11],
  );
});

test("rule and input validation are explicit", () => {
  for (const rule of [
    null,
    { clutterChance: -0.1 },
    { other: 1 },
  ] as unknown[]) {
    assert.equal(validateCellClass(rule).valid, false);
  }
  assert.throws(() =>
    generateRegion({
      ...input,
      candidates: [{ cellIndex: 0, x: 0, y: 0, lootChance: 2 }],
    }),
  );
  assert.throws(() => generateRegion(null as unknown as RegionInput));
  assert.throws(() => generateRegion({ ...input, budget: -1 }));
  assert.throws(() =>
    generateRegion({
      ...input,
      candidates: [{ cellIndex: 0, x: Infinity, y: 0 }],
    }),
  );
});
