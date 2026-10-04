/**
 * The WFC solver is iterative and narrows one grid in place, so a large map neither
 * overflows the call stack (one frame per collapsed cell) nor holds a grid clone per
 * level. This pins both: a bare 1 x N chain, and a 36 x 18 zone playground placement.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { placement } from "../src/chain/placement.ts";
import { resolveLibrary } from "../src/chain/library.ts";
import type { ChainLibrary } from "../src/chain/library.ts";
import type { ChainParams } from "../src/chain/types.ts";
import { solveWfc } from "../src/wfc.ts";
import type { TileOption, WfcGrid } from "../src/wfc.ts";

const content = (name: string): unknown => JSON.parse(readFileSync(new URL(`../content/${name}.json`, import.meta.url), "utf8"));
const LIBRARY: ChainLibrary = resolveLibrary(content("diamond-12x6"), {
  "common-primitives": content("common-primitives"), "common-set-pieces": content("common-set-pieces"),
});

test("a 20,000-cell chain solves without exhausting the stack", () => {
  const cells = 20000;
  const option = (templateId: string): TileOption => ({ templateId, orientation: 0, difficulty: 0, weight: 1 });
  const options = [option("a"), option("b")];
  const grid: WfcGrid = Array.from({ length: cells }, (_, i) => ({
    x: i, y: 0, domain: options,
    links: [...(i > 0 ? [{ cell: i - 1, relation: "r" }] : []), ...(i < cells - 1 ? [{ cell: i + 1, relation: "r" }] : [])],
  }));
  let n = 0;
  const solved = solveWfc(grid, cells, 1, () => true, () => (n = (n * 7 + 3) % 11) / 11, { state: { iterations: 0, maxIterations: 1e9 } });
  assert.ok(solved);
  assert.equal(solved.length, cells);
  assert.ok(solved.every((cell) => cell.domain.length === 1));
});

test("a 36 x 18 zone playground places every slot", () => {
  const params: ChainParams = { mode: "playground", zoneWidth: 36, zoneHeight: 18, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
  const layout = placement("wfc-large-1", params, LIBRARY);
  assert.ok(layout.slots.length > 8000);
  assert.equal(new Set(layout.slots.map((slot) => `${slot.col},${slot.row}`)).size, layout.slots.length);
});
