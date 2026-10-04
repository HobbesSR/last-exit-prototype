/**
 * Zone plans (55): the diamond is the one statement of the map's macro shape. Zones,
 * the mask and the grid size all derive from it, and game mode accepts only the zone
 * sizes it is authored at.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { gridSize } from "../src/chain/declared-grid.ts";
import { DIAMOND, isAuthoredZone, planTiles, zonePlan } from "../src/chain/zone-plan.ts";
import { layoutSlots, makeZones } from "../src/chain/zones.ts";
import type { ChainParams } from "../src/chain/types.ts";

const PARAMS: ChainParams = { zoneWidth: 12, zoneHeight: 6, exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.04, lootTierStep: 0.09 };

test("the diamond occupies the 13 zones the design notes draw, with tier by column and bonus away from the middle row", () => {
  const rows = Array.from({ length: DIAMOND.rows }, (_, row) =>
    Array.from({ length: DIAMOND.columns }, (_, col) => DIAMOND.occupied(col, row) ? String(DIAMOND.tier(col, row)) : "X").join(" "));
  assert.deepEqual(rows, ["X X 3 X X", "X 2 3 4 X", "1 2 3 4 5", "X 2 3 4 X", "X X 3 X X"]);
  assert.deepEqual([0, 1, 2, 3, 4].map((row) => DIAMOND.bonus(2, row)), [2, 1, 0, 1, 2]);
});

test("zones, the mask and the grid size all derive from the plan at any zone size", () => {
  for (const [zoneWidth, zoneHeight] of [[12, 6], [24, 12], [3, 2]]) {
    const params = { ...PARAMS, zoneWidth, zoneHeight };
    const { columns, rows } = planTiles(zonePlan(params), params);
    assert.deepEqual([columns, rows], [5 * zoneWidth, 5 * zoneHeight]);
    assert.deepEqual(gridSize(params), { width: columns * 6, height: rows * 6 });
    assert.equal(makeZones(params).length, 13);
    assert.equal(layoutSlots(params).length, 13 * zoneWidth * zoneHeight);
  }
});

test("game mode accepts the sizes the plan is authored at, and the default is one of them", () => {
  assert.ok(isAuthoredZone(DIAMOND, { zoneWidth: DIAMOND.defaultZone.width, zoneHeight: DIAMOND.defaultZone.height }));
  assert.ok(!isAuthoredZone(DIAMOND, { zoneWidth: 24, zoneHeight: 12 }));
});

test("placement filters are fractions of the map, so they scale with zone size", () => {
  const anchors = (columns: number, rows: number, rule: "enormous" | "medium" | "transit", nth: number, quota: number) => {
    const filter = DIAMOND.placementFilter(rule, nth, quota, columns, rows);
    let n = 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) if (filter({ x, y }, 2)) n++;
    return n / (columns * rows);
  };
  for (const [rule, nth, quota] of [["enormous", 1, 3], ["medium", 0, 4], ["transit", 2, 6]] as const) {
    const small = anchors(60, 30, rule, nth, quota), large = anchors(180, 90, rule, nth, quota);
    assert.ok(Math.abs(small - large) < 0.03, `${rule} admits ${small.toFixed(3)} of a 60 x 30 map and ${large.toFixed(3)} of a 180 x 90 one`);
  }
});
