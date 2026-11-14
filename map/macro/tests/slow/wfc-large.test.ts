/**
 * The WFC solver places a large map without exhausting its stack or search: a 36 x 18 zone
 * playground. Moved from tests/wfc-large.test.ts, which keeps the bare 20,000-cell chain (#1071).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { placement } from "../../src/chain/placement.ts";
import { resolveLibrary } from "../../src/chain/library.ts";
import type { ChainLibrary } from "../../src/chain/library.ts";
import type { ChainParams } from "../../src/chain/types.ts";

const content = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../content/${name}.json`, import.meta.url), "utf8"));
const LIBRARY: ChainLibrary = resolveLibrary(content("diamond-12x6"), {
  "common-primitives@7": content("common-primitives@7"), "common-set-pieces@7": content("common-set-pieces@7"),
});

test("a 36 x 18 zone playground places every slot", () => {
  const params: ChainParams = { mode: "playground", zoneWidth: 36, zoneHeight: 18, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };
  // Under the matched libraries `wfc-large-1` took about 115 s, two attempts reaching the cap
  // before a third placed (42.37's tail), and 28 s with the stall limit; the lookahead places it
  // in one attempt, about 7 s (42.39). This claim is about the cap and the stack, not that seed.
  const layout = placement("wfc-large-2", params, LIBRARY);
  assert.ok(layout.slots.length > 8000);
  assert.equal(new Set(layout.slots.map((slot) => `${slot.col},${slot.row}`)).size, layout.slots.length);
});
