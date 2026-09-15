/**
 * Micro generation end to end: the catalogue actually running inside
 * `generateMap`, not a builder exercised in isolation.
 *
 * The unit suites check that a builder declares what it says it declares. What
 * they cannot check is the join: that the declarations reach the grid, that the
 * second region search still agrees with the cells afterwards, and that the
 * artifact a real seed produces is one `validateMap` accepts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  cellIndexAt,
  cellsCrossed,
  generateMap,
  gridViews,
  validateMap,
} from "../src/core.ts";
import { listBuilders } from "../src/micro/index.ts";
import { DEFAULT_LIBRARY } from "../src/core.ts";

/** One map is expensive, so the whole suite shares these two. */
const map = generateMap("micro-pipeline", { zoneWidth: 4, zoneHeight: 2 });
const again = generateMap("micro-pipeline", { zoneWidth: 4, zoneHeight: 2 });

test("a map built with the catalogue is a valid map", () => {
  const result = validateMap(map);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test("generation stays deterministic once builders may state geometry", () => {
  // Byte equality, not a metric comparison: a builder reading an unseeded
  // source would show up here and nowhere else.
  assert.deepEqual(again.regions, map.regions);
  assert.deepEqual(again.grid, map.grid);
  assert.deepEqual(again.walls, map.walls);
  assert.deepEqual(again.features, map.features);
});

test("every artifact region names the builder that owned its cells", () => {
  const known = new Set(listBuilders().map((builder) => builder.id));
  assert.ok(known.size >= 6, "the catalogue should have registered builders");
  const named = map.regions.filter((region) => region.manifest.generator);
  assert.ok(named.length > 0, "no region reported a generator");
  for (const region of named)
    assert.ok(
      known.has(region.manifest.generator!),
      `region ${region.id} names an unregistered builder: ${region.manifest.generator}`,
    );
  // Material is discovered and left alone, so it must name nobody.
  for (const region of map.regions)
    if (region.cellClass === "solid")
      assert.equal(region.manifest.generator, undefined);
});

test("the second region search leaves class and cells in agreement", () => {
  const views = gridViews(map);
  const claimed = new Set<number>();
  for (const region of map.regions)
    for (const cell of region.cells) {
      assert.equal(
        views.cellClass(cell),
        region.cellClass,
        `cell ${cell} disagrees with region ${region.id}`,
      );
      assert.equal(claimed.has(cell), false, `cell ${cell} is in two regions`);
      claimed.add(cell);
    }
});

test("props stay inside the region that now owns them", () => {
  let counted = 0;
  for (const region of map.regions) {
    const own = new Set(region.cells);
    for (const prop of region.obstacles) {
      const cells = cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2);
      assert.equal(cells.length, 1, "a prop left the cell it belongs to");
      assert.ok(
        own.has(cellIndexAt(map, cells[0]![0]!, cells[0]![1]!)),
        `region ${region.id} owns a prop outside itself`,
      );
      counted += 1;
    }
  }
  assert.ok(counted > 0, "no builder placed any collidable detail at all");
});

test("a manifest counts what landed, not what a builder reported", () => {
  const views = gridViews(map);
  for (const region of map.regions) {
    assert.equal(
      region.manifest.obstaclesPlaced,
      region.obstacles.length,
      `region ${region.id} obstacle manifest disagrees`,
    );
    assert.equal(
      region.manifest.spawnsPlaced,
      region.cells.filter((cell) => views.spawns.has(cell)).length,
      `region ${region.id} spawn manifest disagrees`,
    );
  }
});

test("nothing stands in material", () => {
  const views = gridViews(map);
  for (const [cell] of views.spawns)
    assert.equal(views.cellSolid(cell), false, `spawn ${cell} is in material`);
});

test("the catalogue gives the map friction it did not have", () => {
  // The point of the work, stated as a measurement. Before builders could
  // state geometry the shipped library produced no collidable detail at all
  // and the route to an exit was 1.05x the direct distance across 150 seeds.
  assert.ok(
    map.metrics.obstacleCount! > 0,
    "the shipped library still produces no cover",
  );
  assert.ok(
    map.metrics.interiorWalls > 0,
    "no interior geometry reached the grid",
  );
  // And it is still a map both bodies can cross: friction, not a maze.
  assert.ok(Number.isFinite(map.metrics.contestantDistance));
  assert.ok(Number.isFinite(map.metrics.hunterDistance));
});

test("every class the shipped library declares binds to a real builder", () => {
  const known = new Set(listBuilders().map((builder) => builder.id));
  for (const [name, rule] of Object.entries(
    DEFAULT_LIBRARY.cellClasses ?? {},
  )) {
    if (!rule.generator) continue;
    assert.ok(
      known.has(rule.generator),
      `class ${name} names an unregistered builder: ${rule.generator}`,
    );
  }
});
