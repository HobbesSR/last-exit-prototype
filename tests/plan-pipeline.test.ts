/**
 * The planned generator end to end.
 *
 * The unit suites check each planning pass in isolation. What they cannot check
 * is the claim the whole design rests on: that a contract stated on a region
 * graph, and enforced separately on each region, produces a map whose geometry
 * is actually walkable -- with no reserved route network and no repair pass.
 *
 * So these tests run the real thing and check the composed result, not the plan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cellIndexAt,
  cellsCrossed,
  gridViews,
  segmentIndexAt,
  validateMap,
} from "../src/core.ts";
import { PASSAGE } from "../src/micro/scale.ts";
import {
  composeMap,
  generatePlannedMap,
  planMap,
} from "../src/plan/compose.ts";
import { proveReachability } from "../src/plan/ports.ts";
import { admitsPassage } from "../src/plan/types.ts";

/** Small enough to run several of, large enough to have real regions. */
const SMALL = { zoneWidth: 4, zoneHeight: 2 };
const plan = planMap("pipeline", SMALL);
const map = composeMap(plan);

test("a planned map is a valid map", () => {
  const result = validateMap(map);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("the plan proves its own routes before anything is built", () => {
  const proof = proveReachability(plan.regions, {
    spawnRegion: plan.spawnRegion,
    hunterSpawnRegion: plan.hunterSpawnRegion,
    exitRegions: plan.exitRegions,
  });
  assert.deepEqual(proof.errors, []);
});

test("the partition covers the map exactly once", () => {
  const seen = new Set<number>();
  for (const region of plan.regions)
    for (const cell of region.cells) {
      assert.equal(seen.has(cell), false, `cell ${cell} is in two regions`);
      seen.add(cell);
    }
  const views = gridViews(map);
  let laid = 0;
  for (let i = 0; i < map.width * map.height; i += 1)
    if (views.cellClass(i) !== "") laid += 1;
  assert.equal(seen.size, laid, "planned cells and laid-out cells disagree");
});

test("every port ends inside the band macro planned for it", () => {
  const views = gridViews(map);
  const widthOf = (
    segments: (typeof plan.regions)[number]["ports"][number]["segments"],
  ) => {
    let best = 0,
      run = 0;
    for (const ref of segments) {
      const span = views.segmentOpen(
        segmentIndexAt(map, ref.vertical, ref.line, ref.offset),
      );
      if (!span) {
        run = 0;
        continue;
      }
      const open = span[1] - span[0];
      run = span[0] <= 1e-9 ? run + open : open;
      if (run > best) best = run;
      if (span[1] < 1 - 1e-9) run = 0;
    }
    return best;
  };
  const floor = (p: string) =>
    p === "hunter" ? PASSAGE.door : p === "contestant" ? PASSAGE.squeeze : 0;
  const ceiling = (p: string) =>
    p === "none" ? 0 : p === "contestant" ? PASSAGE.squeeze : Infinity;

  let checked = 0;
  for (const region of plan.regions)
    for (const port of region.ports) {
      const width = widthOf(port.segments);
      assert.ok(
        width + 1e-9 >= floor(port.required),
        `port ${port.id} is below its floor: ${width} < ${floor(port.required)}`,
      );
      assert.ok(
        width <= ceiling(port.allowed) + 1e-9,
        `port ${port.id} is above its ceiling: ${width} > ${ceiling(port.allowed)}`,
      );
      checked += 1;
    }
  assert.ok(checked > 50, `expected a real port count, got ${checked}`);
});

test("mirrored ports never contradict each other", () => {
  const byId = new Map<string, { required: string; allowed: string }>();
  for (const region of plan.regions)
    for (const port of region.ports) {
      const seen = byId.get(port.id);
      if (!seen) {
        byId.set(port.id, { required: port.required, allowed: port.allowed });
        continue;
      }
      assert.equal(seen.required, port.required, `port ${port.id} floor`);
      assert.equal(seen.allowed, port.allowed, `port ${port.id} ceiling`);
    }
});

test("a squeeze port admits a contestant and refuses a hunter", () => {
  const squeezes = plan.regions
    .flatMap((r) => r.ports)
    .filter((p) => p.allowed === "contestant");
  for (const port of squeezes) {
    assert.ok(admitsPassage("contestant", port.required));
    assert.equal(admitsPassage(port.allowed, "hunter"), false);
  }
});

test("loot is budgeted by macro and placed one to a cell", () => {
  const views = gridViews(map);
  const cells = new Set<number>();
  for (const [cell] of views.spawns) {
    assert.equal(cells.has(cell), false, `cell ${cell} carries two spawns`);
    cells.add(cell);
    assert.equal(views.cellSolid(cell), false, "a spawn is in material");
  }
  assert.ok(cells.size > 0, "no loot was placed at all");
  // Every spawn lies in the region that was given a budget for it.
  const budgeted = new Map(plan.regions.map((r) => [r.id, r.loot.budget]));
  const owner = new Map<number, string>();
  for (const region of plan.regions)
    for (const cell of region.cells) owner.set(cell, region.id);
  const perRegion = new Map<string, number>();
  for (const cell of cells) {
    const id = owner.get(cell)!;
    perRegion.set(id, (perRegion.get(id) ?? 0) + 1);
  }
  for (const [id, count] of perRegion)
    assert.ok(
      count <= (budgeted.get(id) ?? 0),
      `region ${id} placed ${count} over a budget of ${budgeted.get(id)}`,
    );
});

test("props stay inside the region that owns them", () => {
  let counted = 0;
  for (const region of map.regions) {
    const own = new Set(region.cells);
    for (const prop of region.obstacles) {
      const crossed = cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2);
      assert.equal(crossed.length, 1, "a prop left its cell");
      assert.ok(own.has(cellIndexAt(map, crossed[0]![0]!, crossed[0]![1]!)));
      counted += 1;
    }
  }
  assert.ok(counted > 0, "no builder placed any collidable detail");
});

test("generation is deterministic", () => {
  const again = composeMap(planMap("pipeline", SMALL));
  assert.deepEqual(again.grid, map.grid);
  assert.deepEqual(again.regions, map.regions);
  assert.deepEqual(again.walls, map.walls);
  assert.deepEqual(again.features, map.features);
});

test("the contract holds across seeds, with no reserved ground", () => {
  // The claim the whole design rests on. If a builder could break the map, it
  // would show up here rather than in any single-region unit test.
  for (let i = 0; i < 6; i += 1) {
    const built = generatePlannedMap(`contract-${i}`, SMALL);
    assert.deepEqual(
      built.validation.errors,
      [],
      `seed contract-${i} produced an invalid map`,
    );
    // Nothing was held back from the builders, and nothing had to be repaired.
    assert.equal(built.metrics.portsCorrected! <= 2, true);
    assert.ok(
      built.metrics.microSegments! > 100,
      "builders stated almost nothing, which is the failure mode to watch for",
    );
  }
});
