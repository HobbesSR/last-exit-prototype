import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { boundaryRuns } from '../map/kernel/run.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle } from '../shared/shape.ts';
import { hintErrors, hintedCells } from '../map/micro/hints.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals) => ({ id, seed, type: 'block', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.3, cells }], portals });

/** A wide field, an L, a ring around a hole and a deep block, with portals on several sides. */
const MASKS = {
  field: [cellsOf(44, 34), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 44, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(56, 56, (x, y) => y < 26 || x < 26), [{ id: 'east', axis: 'v', x: 56, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 56, length: 4 },
    { id: 'corner', axis: 'h', x: 30, y: 26, length: 6 }]],
  ring: [cellsOf(64, 64, (x, y) => x < 24 || x >= 40 || y < 24 || y >= 40), [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 40, y: 28, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 50, length: 3 }]],
  deep: [cellsOf(72, 60), [{ id: 'west', axis: 'v', x: 0, y: 30, length: 2 }, { id: 'east', axis: 'v', x: 72, y: 2, length: 2 },
    { id: 'south', axis: 'h', x: 60, y: 60, length: 2 }, { id: 'north', axis: 'h', x: 4, y: 0, length: 2 }]],
};
const SEEDS = [1, 2, 3, 4];
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const key = c => `${c.x},${c.y}`;
const sameRun = (p, q) => p.axis === q.axis && p.x === q.x && p.y === q.y && p.length === q.length;
const built = new Map();
const sample = input => {
  const id = JSON.stringify(input);
  if (!built.has(id)) built.set(id, buildRegion(input));
  return built.get(id);
};

test('every lot keeps its own promise between its frontages, and a hunter reaches it from the block\'s first portal', () => {
  const radius = hunterClearance(SIZE);
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 1)) {
    const input = brief(name, seed, cells, portals), result = sample(input), mask = createRegionMask(input), shapes = blockers(result);
    const from = portalStands(input, mask)[0].points[0];
    for (const lot of planBlock(input).lots) {
      const own = buildRegion(lot);
      assert.deepEqual(validatePortalReach({ ...lot, blockers: blockers(own) }).errors, [], `${name} ${seed}: ${lot.id} (${lot.type})`);
      // Its own promise joins the frontages, so one stand inside them stands for the lot.
      const point = portalStands(lot)[0].points[0];
      assert.ok(findRegionRoute(mask, shapes, from, point, radius), `${name} ${seed}: ${lot.id} (${lot.type}) at ${point.x},${point.y}`);
    }
  }
});
