/**
 * Loot allocation, both halves: macro decides how much and of what tier, the
 * region decides where. The seam between them is a `LootCriteria`, so these
 * tests never assert that a particular cell got loot -- only that the count is
 * what macro asked for and that every cell chosen was one a body can use.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS } from "../src/core.ts";
import { createMask } from "../src/micro/mask.ts";
import { createRng } from "../src/micro/rng.ts";
import { placeLoot } from "../src/micro/loot.ts";
import { allocateLoot, deriveLoot } from "../src/plan/loot.ts";
import type { PartitionedRegion } from "../src/plan/loot.ts";
import type { Box, MapParams, RegionCandidate } from "../src/types.ts";
import type { GridAxis, RegionContext } from "../src/micro/types.ts";

const W = 24;
const H = 16;
const TILE = DEFAULT_PARAMS.tileSize;
/** A 12 x 8 region: 96 cells, 24 of them on the spaced lattice. */
const REGION: Box = [4, 4, 15, 11];
const PARAMS: MapParams = { ...DEFAULT_PARAMS };

function rectCells(box: Box, width = W): number[] {
  const out: number[] = [];
  for (let y = box[1]; y <= box[3]; y += 1)
    for (let x = box[0]; x <= box[2]; x += 1) out.push(y * width + x);
  return out;
}

const cellAt = (x: number, y: number): number => y * W + x;

/** One partitioned region. Only `cells` and `tier` reach the budget formula. */
function makeRegion(
  id: string,
  tier: number,
  cells: number[],
  bounds: Box = REGION,
): PartitionedRegion {
  return { id, type: "open-field", seed: 1, cells, bounds, tier, bonus: 0 };
}

/** A square region of exactly `side * side` cells, for round arithmetic. */
function squareRegion(
  id: string,
  tier: number,
  side: number,
): PartitionedRegion {
  const box: Box = [0, 0, side - 1, side - 1];
  return makeRegion(id, tier, rectCells(box, side), box);
}

function makeGrid(): GridAxis {
  return {
    tileSize: TILE,
    tileOf: (x, y) => ({
      col: Math.floor(x / TILE),
      row: Math.floor(y / TILE),
    }),
    tileBounds: (col, row) => [
      col * TILE,
      row * TILE,
      col * TILE + TILE - 1,
      row * TILE + TILE - 1,
    ],
    onTileBorder: (x, y) => x % TILE === 0 || y % TILE === 0,
    onTileSeam: (ref) => ref.line % TILE === 0,
    snap: (value) => Math.round(value / TILE) * TILE,
  };
}

interface ContextOptions {
  seed?: string;
  cells?: number[];
  reserved?: Array<[number, number]>;
  budget?: number;
}

/** A context built from the real mask and rng, so nothing here is a stand-in. */
function makeContext(options: ContextOptions = {}): RegionContext {
  const seed = options.seed ?? "plan-loot";
  const cells = options.cells ?? rectCells(REGION);
  const reserved = new Set(
    (options.reserved ?? []).map(([x, y]) => `${x},${y}`),
  );
  const mask = createMask(cells, W, H);
  const candidates: RegionCandidate[] = mask
    .lattice(2, 1, 1)
    .map((cell) => ({ cellIndex: cell.cellIndex, x: cell.x, y: cell.y }));
  return {
    regionId: "r-loot",
    cellClass: "yard",
    rule: {},
    seed,
    rng: createRng(seed),
    mask,
    grid: makeGrid(),
    params: PARAMS,
    candidates,
    budget: options.budget ?? 1000,
    isReserved: (x, y) => reserved.has(`${x},${y}`),
    isStandingRoom: () => false,
    openings: [],
    corridors: [],
    clearance: {
      contestant: PARAMS.contestantRadius,
      hunter: PARAMS.hunterRadius,
    },
    zoneAt: () => ({ tier: 1, bonus: 0, lootChance: PARAMS.lootChance }),
  };
}

const indices = (placement: {
  spawns: Array<{ cellIndex: number }>;
}): number[] => placement.spawns.map((spawn) => spawn.cellIndex);

/* ------------------------------------------------------- macro: how much -- */

test("budget rises with tier and never exceeds the region's area", () => {
  const budgets = [1, 2, 3, 4, 5].map(
    (tier) => deriveLoot(squareRegion(`r-${tier}`, tier, 10), PARAMS).budget,
  );
  // 6 per hundred cells at tier 1, times (1 + 0.35 * (tier - 1)).
  assert.deepEqual(budgets, [6, 8, 10, 12, 14]);
  for (let i = 1; i < budgets.length; i += 1)
    assert.ok(
      budgets[i]! > budgets[i - 1]!,
      "tier must pay more than the one before",
    );

  // One spawn per cell is the placement rule, so a budget above the cell count
  // is unsatisfiable by construction and macro must never state one.
  const tiny = deriveLoot(squareRegion("r-tiny", 5, 2), PARAMS, {
    perHundredCells: 500,
  });
  assert.equal(tiny.budget, 4);
  assert.equal(tiny.density, 1);

  // The ceiling exists so one huge region cannot eat the map.
  const huge = deriveLoot(squareRegion("r-huge", 5, 40), PARAMS);
  assert.equal(huge.budget, 20);
  assert.ok(huge.density < 0.02);

  // Tier travels with the criteria untouched: it is what a builder reads to
  // vary its form, not something the budget formula may rewrite.
  assert.equal(deriveLoot(squareRegion("r-t", 4, 10), PARAMS).tier, 4);
});

test("density is the budget spread over the region, and policy is honoured", () => {
  const region = squareRegion("r-d", 3, 10);
  const criteria = deriveLoot(region, PARAMS);
  assert.equal(criteria.density, criteria.budget / region.cells.length);

  const flat = deriveLoot(region, PARAMS, { perHundredCells: 10, tierStep: 0 });
  assert.equal(flat.budget, 10);
  assert.equal(
    deriveLoot(squareRegion("r-d5", 5, 10), PARAMS, {
      perHundredCells: 10,
      tierStep: 0,
    }).budget,
    10,
    "a zero tier step is a flat map, not a broken one",
  );

  // The legacy master switch still turns loot off across both paths.
  const off = deriveLoot(region, { ...PARAMS, lootChance: 0 });
  assert.deepEqual(off, { budget: 0, tier: 3, density: 0 });
});

test("allocateLoot totals match the sum of the parts", () => {
  const regions = [
    squareRegion("a", 1, 10),
    squareRegion("b", 3, 10),
    squareRegion("c", 3, 8),
    squareRegion("d", 5, 12),
  ];
  const { loot, total, byTier } = allocateLoot(regions, PARAMS);

  assert.equal(loot.size, regions.length);
  let sum = 0;
  for (const region of regions) {
    const criteria = loot.get(region.id);
    assert.ok(criteria, `no criteria for ${region.id}`);
    assert.deepEqual(criteria, deriveLoot(region, PARAMS));
    sum += criteria.budget;
  }
  assert.equal(total, sum);
  assert.equal(
    byTier.reduce((a, b) => a + b, 0),
    total,
    "byTier must add up to the total",
  );
  // Indexed by tier, so slot 0 is empty and tier 3 is both tier-3 regions.
  assert.equal(byTier[0], 0);
  assert.equal(byTier[3], loot.get("b")!.budget + loot.get("c")!.budget);
  assert.ok(byTier[5]! > byTier[1]!, "progression must show in the totals");

  const empty = allocateLoot([], PARAMS);
  assert.equal(empty.total, 0);
  assert.equal(empty.loot.size, 0);
  assert.deepEqual(empty.byTier, [0, 0, 0, 0, 0, 0]);
});

/* -------------------------------------------------------- micro: where ---- */

test("at most one spawn per cell, and always inside the region", () => {
  // A region with two holes punched in it: a region is an area, not a rect.
  const holes = new Set([
    cellAt(7, 7),
    cellAt(8, 7),
    cellAt(7, 8),
    cellAt(12, 9),
  ]);
  const cells = rectCells(REGION).filter((index) => !holes.has(index));
  const context = makeContext({ cells });
  const placement = placeLoot(context, { budget: 40, tier: 3, density: 0.4 });

  const chosen = indices(placement);
  assert.equal(
    new Set(chosen).size,
    chosen.length,
    "a cell may hold one spawn",
  );
  assert.equal(placement.placed, chosen.length);
  const region = new Set(cells);
  for (const index of chosen) {
    assert.ok(region.has(index), `spawn outside the region at ${index}`);
    assert.ok(!holes.has(index), "a hole is not part of the region");
  }
  assert.deepEqual(
    chosen,
    [...chosen].sort((a, b) => a - b),
    "spawns come back ascending by cell index",
  );
  for (const spawn of placement.spawns) assert.equal(spawn.kind, "loot");
});

test("reserved cells and the builder's own claim never receive a spawn", () => {
  const reserved: Array<[number, number]> = [
    [5, 5],
    [6, 5],
    [9, 9],
  ];
  // The four cells an interior slot is approached across: (8, 8) is legal
  // ground the builder has boxed in, and a spawn there would be stranded.
  const taken = new Set([
    cellAt(7, 8),
    cellAt(9, 8),
    cellAt(8, 7),
    cellAt(8, 9),
    cellAt(11, 11),
  ]);
  const context = makeContext({ reserved });
  // More than the region can hold, so every eligible cell is tried.
  const placement = placeLoot(
    context,
    { budget: 200, tier: 5, density: 1 },
    taken,
  );
  const chosen = new Set(indices(placement));

  for (const [x, y] of reserved)
    assert.ok(
      !chosen.has(cellAt(x, y)),
      `reserved cell ${x},${y} took a spawn`,
    );
  for (const index of taken)
    assert.ok(!chosen.has(index), `claimed cell ${index} took a spawn`);
  assert.ok(
    !chosen.has(cellAt(8, 8)),
    "a cell with no way in is not standing room",
  );
  assert.ok(placement.placed > 0, "the rest of the region is still usable");
});

test("the spaced lattice is preferred before anything denser", () => {
  const context = makeContext();
  // Well under the 24 cells of lattice(2, 1, 1) over this region.
  const placement = placeLoot(context, { budget: 6, tier: 2, density: 0.1 });
  assert.equal(placement.placed, 6);

  const chosen = new Set(indices(placement));
  for (const index of chosen) {
    const x = index % W;
    const y = (index - x) / W;
    assert.ok(x % 2 === 1 && y % 2 === 1, `off the lattice at ${x},${y}`);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const)
      assert.ok(
        !chosen.has(cellAt(x + dx, y + dy)),
        `spawns are orthogonally adjacent at ${x},${y}`,
      );
  }
});

test("a budget larger than the region reports the shortfall", () => {
  const context = makeContext();
  const placement = placeLoot(context, { budget: 500, tier: 5, density: 1 });
  assert.equal(placement.wanted, 500);
  assert.ok(placement.placed < placement.wanted, "it cannot have met that");
  assert.equal(
    placement.placed,
    context.mask.area,
    "but it filled what it had",
  );
  assert.equal(placement.spawns.length, placement.placed);

  // The context's cap is the harness's word and may be tighter than macro's.
  const capped = placeLoot(makeContext({ budget: 5 }), {
    budget: 40,
    tier: 5,
    density: 1,
  });
  assert.equal(capped.wanted, 5);
  assert.equal(capped.placed, 5);
});

test("placement is deterministic in the seed and mutates nothing", () => {
  const criteria = Object.freeze({ budget: 9, tier: 3, density: 0.1 });
  const taken = new Set([cellAt(6, 6), cellAt(10, 10)]);
  const before = { size: taken.size, members: [...taken] };

  const first = placeLoot(makeContext(), criteria, taken);
  const again = placeLoot(makeContext(), criteria, taken);
  assert.deepEqual(first, again, "same seed, same cells");

  const context = makeContext();
  const cellsBefore = context.mask.cells.length;
  const candidatesBefore = context.candidates.map((c) => c.cellIndex);
  const repeated = placeLoot(context, criteria, taken);
  assert.deepEqual(
    indices(repeated),
    indices(placeLoot(context, criteria, taken)),
  );
  assert.equal(context.mask.cells.length, cellsBefore);
  assert.deepEqual(
    context.candidates.map((c) => c.cellIndex),
    candidatesBefore,
  );
  assert.equal(taken.size, before.size);
  assert.deepEqual([...taken], before.members);

  const other = placeLoot(
    makeContext({ seed: "plan-loot-2" }),
    criteria,
    taken,
  );
  assert.notDeepEqual(indices(other), indices(first), "the seed must matter");
});

test("a zero budget and an empty region both come back empty", () => {
  const context = makeContext();
  for (const budget of [0, -3, Number.NaN]) {
    const placement = placeLoot(context, { budget, tier: 1, density: 0 });
    assert.deepEqual(placement.spawns, []);
    assert.equal(placement.placed, 0);
    assert.equal(placement.wanted, 0);
  }

  const empty = placeLoot(makeContext({ cells: [] }), {
    budget: 12,
    tier: 1,
    density: 0.5,
  });
  assert.deepEqual(empty.spawns, []);
  assert.equal(empty.placed, 0);
  assert.equal(empty.wanted, 12, "what was asked for is still reported");
});

/* -------------------------------------------------------- the two halves -- */

test("a region places what macro allocated it when it has the room", () => {
  const region = makeRegion("r-1", 4, rectCells(REGION));
  const criteria = deriveLoot(region, PARAMS);
  const placement = placeLoot(makeContext(), criteria);
  assert.equal(placement.wanted, criteria.budget);
  assert.equal(placement.placed, criteria.budget, "96 cells hold this easily");
});
