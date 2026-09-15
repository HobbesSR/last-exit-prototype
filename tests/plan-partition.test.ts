import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, makeZones } from "../src/core.ts";
import {
  DEFAULT_TYPE_TABLE,
  partitionRegions,
  type PartitionedRegion,
  type RegionTypeTable,
} from "../src/plan/partition.ts";
import type { MapParams, MapZone } from "../src/types.ts";

const PARAMS: MapParams = { ...DEFAULT_PARAMS };
const WIDTH = PARAMS.columns * PARAMS.tileSize;
const ZONES = makeZones(PARAMS);

/**
 * The mask a real map has: every cell of every occupied zone. The zone diamond
 * is the map, so this is the stair-stepped boundary the generator actually
 * partitions, not a convenient rectangle.
 */
function fullMask(zones: MapZone[] = ZONES): number[] {
  const cells = new Set<number>();
  for (const zone of zones) {
    const [x0, y0, x1, y1] = zone.cells;
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) cells.add(y * WIDTH + x);
  }
  return [...cells].sort((a, b) => a - b);
}

/** One tile's worth of cells at a tile origin, for the degenerate cases. */
function tileMask(col: number, row: number): number[] {
  const size = PARAMS.tileSize;
  const cells: number[] = [];
  for (let y = row * size; y < (row + 1) * size; y += 1)
    for (let x = col * size; x < (col + 1) * size; x += 1)
      cells.push(y * WIDTH + x);
  return cells.sort((a, b) => a - b);
}

const MASK = fullMask();
const PARTITION = partitionRegions("partition-fixture", PARAMS, ZONES, MASK);

/** Distinct tiles a region covers. */
function tilesOf(region: PartitionedRegion): Set<number> {
  const size = PARAMS.tileSize;
  const tiles = new Set<number>();
  for (const cell of region.cells) {
    const x = cell % WIDTH;
    const y = Math.floor(cell / WIDTH);
    tiles.add(Math.floor(y / size) * PARAMS.columns + Math.floor(x / size));
  }
  return tiles;
}

/* ------------------------------------------------------ totality --------- */

test("the partition is total and disjoint over the mask", () => {
  const seen = new Map<number, string>();
  for (const region of PARTITION) {
    for (const cell of region.cells) {
      const owner = seen.get(cell);
      assert.equal(
        owner,
        undefined,
        `cell ${cell} claimed by both ${owner} and ${region.id}`,
      );
      seen.set(cell, region.id);
    }
  }
  assert.equal(seen.size, MASK.length, "every masked cell is claimed once");

  const masked = new Set(MASK);
  for (const cell of seen.keys()) {
    assert.ok(masked.has(cell), `region claims unmasked cell ${cell}`);
  }
});

test("cells are ascending and bounds are the inclusive cell box", () => {
  for (const region of PARTITION) {
    for (let i = 1; i < region.cells.length; i += 1) {
      assert.ok(
        region.cells[i] > region.cells[i - 1],
        `${region.id} cells are not strictly ascending`,
      );
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const cell of region.cells) {
      const x = cell % WIDTH;
      const y = Math.floor(cell / WIDTH);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    assert.deepEqual(region.bounds, [x0, y0, x1, y1], `${region.id} bounds`);
  }
});

/* ----------------------------------------------------- contiguity -------- */

test("every region is 4-connected over its own cells", () => {
  for (const region of PARTITION) {
    const own = new Set(region.cells);
    const seen = new Set<number>([region.cells[0]]);
    const queue = [region.cells[0]];
    while (queue.length > 0) {
      const cell = queue.pop() as number;
      const x = cell % WIDTH;
      const y = Math.floor(cell / WIDTH);
      for (const [dx, dy] of [
        [0, -1],
        [-1, 0],
        [1, 0],
        [0, 1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= WIDTH) continue;
        const next = ny * WIDTH + nx;
        if (!own.has(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    assert.equal(
      seen.size,
      region.cells.length,
      `${region.id} is split into disconnected pieces`,
    );
  }
});

/* ---------------------------------------------------- determinism -------- */

test("the same inputs give a deep-equal partition", () => {
  const again = partitionRegions("partition-fixture", PARAMS, ZONES, MASK);
  assert.deepEqual(again, PARTITION);
});

test("a different seed gives a different partition", () => {
  const other = partitionRegions("partition-other", PARAMS, ZONES, MASK);
  assert.notDeepEqual(other, PARTITION);
  // Still a valid partition, not merely a different one.
  const cells = other.flatMap((region) => region.cells);
  assert.equal(new Set(cells).size, MASK.length);
});

test("ids are r-0.. in lowest-cell order and stable across runs", () => {
  const again = partitionRegions("partition-fixture", PARAMS, ZONES, MASK);
  PARTITION.forEach((region, index) => {
    assert.equal(region.id, `r-${index}`);
    assert.equal(again[index].id, region.id);
    assert.equal(again[index].cells[0], region.cells[0]);
    // The id is a function of the shape: sorted by lowest cell, ascending.
    if (index > 0) {
      assert.ok(region.cells[0] > PARTITION[index - 1].cells[0]);
    }
  });
});

test("the region seed is a 32-bit integer tied to the map seed", () => {
  const other = partitionRegions("partition-other", PARAMS, ZONES, MASK);
  for (const region of PARTITION) {
    assert.ok(
      Number.isInteger(region.seed),
      `${region.id} seed not an integer`,
    );
    assert.ok(region.seed >= 0 && region.seed <= 0xffffffff);
  }
  // Same region shape under another map seed must not reuse the same number.
  const byLowestCell = new Map(other.map((r) => [r.cells[0], r.seed]));
  let compared = 0;
  for (const region of PARTITION) {
    const twin = byLowestCell.get(region.cells[0]);
    if (twin === undefined) continue;
    compared += 1;
    assert.notEqual(twin, region.seed);
  }
  assert.ok(compared > 0, "no comparable regions between the two seeds");
});

/* ---------------------------------------------------------- size --------- */

test("regions are sized for the builders, not for the fallback", () => {
  const sizes = PARTITION.map((region) => tilesOf(region).size);
  const big = sizes.filter((tiles) => tiles >= 2).length;
  const share = big / sizes.length;
  assert.ok(
    share >= 0.9,
    `only ${(share * 100).toFixed(1)}% of ${sizes.length} regions reach 2 tiles`,
  );
  // 36 cells is the largest minArea in the catalogue (compound, pillar-hall).
  for (const region of PARTITION) {
    assert.ok(
      region.cells.length >= 36,
      `${region.id} has ${region.cells.length} cells, under the largest minArea`,
    );
  }
});

test("no region is left below two tiles after the sliver merge", () => {
  for (const region of PARTITION) {
    assert.ok(
      tilesOf(region).size >= 2,
      `${region.id} is a ${tilesOf(region).size}-tile sliver`,
    );
  }
});

test("a larger tilesPerRegion makes fewer, larger regions", () => {
  const coarse = partitionRegions("partition-fixture", PARAMS, ZONES, MASK, {
    tilesPerRegion: 9,
  });
  assert.ok(
    coarse.length < PARTITION.length,
    `${coarse.length} regions at 9 tiles vs ${PARTITION.length} at 4`,
  );
  const mean =
    coarse.reduce((sum, region) => sum + tilesOf(region).size, 0) /
    coarse.length;
  assert.ok(mean > 4, `mean region is ${mean.toFixed(2)} tiles`);
});

/* ----------------------------------------------------------- type -------- */

test("type assignment only ever emits ids from the table", () => {
  const allowed = new Set(DEFAULT_TYPE_TABLE.default.map((e) => e.type));
  const used = new Set<string>();
  for (const region of PARTITION) {
    assert.ok(allowed.has(region.type), `unknown builder id ${region.type}`);
    used.add(region.type);
  }
  // Every weighted id should turn up over a few hundred regions; a weight that
  // never fires is a bug in the walk, not a rare roll.
  assert.deepEqual([...used].sort(), [...allowed].sort());
});

test("a byTier entry overrides the default for that tier only", () => {
  const table: RegionTypeTable = {
    default: [{ type: "open-field", weight: 1 }],
    byTier: { 3: [{ type: "compound", weight: 1 }] },
  };
  const tiered = partitionRegions("partition-fixture", PARAMS, ZONES, MASK, {
    types: table,
  });
  let inTier3 = 0;
  for (const region of tiered) {
    if (region.tier === 3) {
      inTier3 += 1;
      assert.equal(region.type, "compound");
    } else {
      assert.equal(region.type, "open-field");
    }
  }
  assert.ok(inTier3 > 0, "no region landed in tier 3");
});

/* ---------------------------------------------------------- zones -------- */

test("tier and bonus come from a real zone and stay in range", () => {
  const tiers = new Set(ZONES.map((zone) => zone.tier));
  const bonuses = new Set(ZONES.map((zone) => zone.bonus));
  const pairs = new Set(ZONES.map((zone) => `${zone.tier}/${zone.bonus}`));
  for (const region of PARTITION) {
    assert.ok(tiers.has(region.tier), `${region.id} tier ${region.tier}`);
    assert.ok(bonuses.has(region.bonus), `${region.id} bonus ${region.bonus}`);
    assert.ok(region.tier >= 1 && region.tier <= 5);
    assert.ok(region.bonus >= 0 && region.bonus <= 2);
    // Not an average of two zones: the pair must be one that exists.
    assert.ok(pairs.has(`${region.tier}/${region.bonus}`));
  }
});

/* ------------------------------------------------------ degenerate ------- */

test("an empty mask yields no regions", () => {
  assert.deepEqual(partitionRegions("x", PARAMS, ZONES, []), []);
});

test("a one-tile mask yields one region and does not throw", () => {
  const mask = tileMask(ZONES[0].tiles[0], ZONES[0].tiles[1]);
  const regions = partitionRegions("x", PARAMS, ZONES, mask);
  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0].cells, mask);
  assert.equal(regions[0].id, "r-0");
  // Nothing to merge into, so the sliver survives rather than throwing.
  assert.equal(tilesOf(regions[0]).size, 1);
});

test("two disjoint islands stay separate regions", () => {
  const [z] = ZONES;
  const mask = [
    ...tileMask(z.tiles[0], z.tiles[1]),
    ...tileMask(z.tiles[0] + 4, z.tiles[1] + 2),
  ].sort((a, b) => a - b);
  const regions = partitionRegions("islands", PARAMS, ZONES, mask);
  assert.equal(regions.length, 2);
  assert.equal(
    regions.reduce((sum, region) => sum + region.cells.length, 0),
    mask.length,
  );
});

test("a ragged mask stays total without leaking unmasked cells", () => {
  // Half a tile column, so tiles are only partly covered and the whole-tile
  // growth has to fall back to the masked cells when it converts.
  const mask = MASK.filter((cell) => cell % WIDTH < WIDTH / 2);
  const regions = partitionRegions("ragged", PARAMS, ZONES, mask);
  const claimed = regions.flatMap((region) => region.cells);
  assert.equal(new Set(claimed).size, mask.length);
  const masked = new Set(mask);
  for (const cell of claimed) assert.ok(masked.has(cell));
});
