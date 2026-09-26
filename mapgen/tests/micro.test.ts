import test from "node:test";
import assert from "node:assert/strict";
import { generateRegion } from "../src/regions.ts";
import {
  cellsCrossed,
  cellIndexAt,
  generateMap,
  validateMap,
} from "../src/core.ts";
import type { RegionInput } from "../src/types.ts";

const area = [
  { cellIndex: 10, x: 4, y: 2 },
  { cellIndex: 11, x: 5, y: 2 },
  { cellIndex: 20, x: 4, y: 3 },
  { cellIndex: 21, x: 5, y: 3 },
];
const input: RegionInput = {
  seed: "clutter",
  cellClass: "vault",
  candidates: [],
  budget: 0,
  area,
};

test("micro detail may be collidable and off the cell lattice", () => {
  const out = generateRegion(input, { clutterChance: 1 });
  assert.equal(out.obstacles.length, area.length);
  assert.equal(out.manifest.obstaclesPlaced, area.length);
  // Props are not axis aligned: that is the point of them being micro detail.
  assert.ok(
    out.obstacles.some((o) => o.x1 !== o.x2 && o.y1 !== o.y2),
    "expected geometry off the grid",
  );
  // Each stays inside the single cell it belongs to.
  for (const o of out.obstacles) {
    const cells = cellsCrossed(o.x1, o.y1, o.x2, o.y2);
    assert.equal(cells.length, 1);
    assert.ok(area.some((c) => c.x === cells[0]![0] && c.y === cells[0]![1]));
  }
  // And it is deterministic.
  assert.deepEqual(
    generateRegion(input, { clutterChance: 1 }).obstacles,
    out.obstacles,
  );
});

test("clutter never takes a cell a spawn already claimed", () => {
  const withLoot = generateRegion(
    {
      ...input,
      candidates: area.map((c) => ({ ...c, lootChance: 1 })),
      budget: 4,
    },
    { clutterChance: 1 },
  );
  const spawned = new Set(withLoot.spawns.map((s) => s.cellIndex));
  assert.equal(spawned.size, area.length);
  assert.equal(withLoot.obstacles.length, 0);
});

test("a region rule must declare what it wants", () => {
  assert.throws(() => generateRegion(input, { clutterChance: 2 } as never));
  assert.throws(() => generateRegion(input, { clutterSize: 1 } as never));
  assert.throws(() => generateRegion(input, { clutter: true } as never));
});

test("validation keeps micro geometry inside the region that made it", () => {
  const m = generateMap("micro");
  assert.equal(m.validation.valid, true);
  const region = m.regions.find((r) => r.area >= 12)!;
  const first = region.cells[0]!;
  const x = first % m.grid.width,
    y = Math.floor(first / m.grid.width);

  // A prop inside its own region is accepted.
  region.obstacles.push({
    x1: x + 0.4,
    y1: y + 0.35,
    x2: x + 0.6,
    y2: y + 0.65,
  });
  region.manifest.obstaclesPlaced = 1;
  assert.equal(
    validateMap(m).errors.filter((e) => /outside itself/.test(e)).length,
    0,
  );

  // One that reaches into a neighbouring region is not.
  region.obstacles[0] = { x1: x + 0.5, y1: y + 0.5, x2: x + 9, y2: y + 9 };
  const escaped = validateMap(m);
  assert.equal(escaped.valid, false);
  assert.ok(escaped.errors.some((e) => /outside itself/.test(e)));

  // A manifest that disagrees with the geometry is not either.
  region.obstacles = [];
  assert.ok(
    validateMap(m).errors.some((e) => /obstacle manifest disagrees/.test(e)),
  );
});

test("micro geometry that severs a proven route fails validation", () => {
  const m = generateMap("micro-block");
  assert.equal(m.validation.valid, true);
  const spawn = m.features.find((f) => f.kind === "spawn")!;
  const tile = m.tiles.find((t) => t.id === spawn.tileId)!;
  // A diagonal slab across the tile's standing room, still on no grid line.
  const region = m.regions.find((r) =>
    r.cells.includes(
      cellIndexAt(m, Math.floor(tile.anchor.x), Math.floor(tile.anchor.y)),
    ),
  )!;
  region.obstacles = [
    { x1: tile.x + 0.1, y1: tile.y + 0.2, x2: tile.x + 5.9, y2: tile.y + 5.8 },
  ];
  region.manifest.obstaclesPlaced = 1;
  m.walls.push(region.obstacles[0]!);
  const result = validateMap(m);
  assert.equal(result.valid, false);
  // Containment or clearance — either way the artifact is rejected, not trusted.
  assert.ok(
    result.errors.some((e) => /cannot reach|blocks|outside itself/.test(e)),
    result.errors.slice(0, 3).join("; "),
  );
});

test("cellsCrossed walks every cell a segment touches", () => {
  assert.deepEqual(cellsCrossed(0.5, 0.5, 0.9, 0.9), [[0, 0]]);
  assert.deepEqual(cellsCrossed(0.5, 0.5, 2.5, 0.5), [
    [0, 0],
    [1, 0],
    [2, 0],
  ]);
  const diagonal = cellsCrossed(0.5, 0.5, 2.5, 2.5);
  assert.ok(diagonal.length >= 3);
  assert.deepEqual(diagonal[0], [0, 0]);
  assert.deepEqual(diagonal.at(-1), [2, 2]);
});
