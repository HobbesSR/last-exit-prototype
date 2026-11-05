import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { createRegionMask, elementShapes } from '../../map/micro/geometry.ts';
import { portalMargin } from '../../map/micro/hints.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { bounds } from '../../shared/shape.ts';
import { cellsOf } from './cells.js';

/** Park fixtures shared by tests/micro-park.test.js and tests/slow/micro-park-promise.test.js. */
export const SIZE = 40;
/** Park places against a live cord witness, so its proofs are the thorough search's (20.10). */
export const THOROUGH = { search: 'thorough' };
export const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'park', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, ...(parameters ? { parameters } : {}) });

/** A tile, a wide field, an L, and a ring around a hole, with portals on several sides. */
export const MASKS = {
  tile: [cellsOf(6, 6), [{ id: 'west', axis: 'v', x: 0, y: 2, length: 2 }, { id: 'east', axis: 'v', x: 6, y: 1, length: 3 }]],
  field: [cellsOf(40, 30), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }]],
  ring: [cellsOf(36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23), [{ id: 'north', axis: 'h', x: 15, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 23, y: 16, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 26, length: 3 }]],
};
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
export const DENSE = { density: 1, hedges: 0.5 };
export const blockers = result => result.elements.flatMap(element => elementShapes(element));
export const kind = prefix => element => element.label.startsWith(`park-${prefix}`);
export const boxOf = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });
export const gapBetween = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

/**
 * A mask's park at a seed under `parameters`, built once per process: the promise, clump and
 * kind checks read the same builds (#807). Callers read the result and never change it.
 */
const builds = new Map();
export function built(name, seed, parameters) {
  const key = `${name} ${seed} ${JSON.stringify(parameters)}`;
  if (!builds.has(key)) {
    const [cells, portals] = MASKS[name];
    builds.set(key, buildRegion(brief(name, seed, cells, portals, parameters)));
  }
  return builds.get(key);
}

/**
 * A park keeps the portal promise on every mask at each of `seeds`, under each parameter set. The
 * fast tier runs the first seed and tests/slow/micro-park-promise.test.js all eight: with hedge
 * fronts on by default (types-62, #760) the eight took 24 s (31).
 */
export function assertParkPromise(seeds) {
  for (const name of Object.keys(MASKS)) for (const seed of seeds)
    for (const parameters of [undefined, DENSE, { density: 0, hedges: 1 }, { density: 0.3, hedges: 0 }]) {
      const result = built(name, seed, parameters);
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) }, THOROUGH);
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
}

/**
 * Clumps keep an aisle from each other and respect portal margins on every mask at each of
 * `seeds`. The fast tier runs two seeds and tests/slow/micro-park-promise.test.js all eight (31).
 */
export function assertClumpSpacing(seeds) {
  // Hedge runs gave way to fronts in #760; fronts are tested in micro-park-fronts.
  let clumps = 0;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds) {
    const input = brief(name, seed, cells, portals, DENSE);
    const result = built(name, seed, DENSE), mask = createRegionMask(input);
    const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
    const trees = result.elements.filter(kind('tree')).map(boxOf);
    clumps += result.manifest.clumps;
    for (const tree of trees) for (let y = tree.y; y < tree.y + tree.h; y++) for (let x = tree.x; x < tree.x + tree.w; x++)
      assert.ok(mask.has(x, y) && !reserved.has(`${x},${y}`), `${name} ${seed}: tree footprint`);
    // Trees in different clumps keep their aisle: any two closer than it are in one clump (a slot's band).
    for (const [i, a] of trees.entries()) for (const b of trees.slice(i + 1))
      if (gapBetween(a, b) < 2) assert.ok(Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4, `${name} ${seed}: trees ${a.x},${a.y} and ${b.x},${b.y}`);
  }
  assert.ok(clumps > 2 * seeds.length, `${clumps} clumps`);
}

/**
 * Pieces keep valid geometry inside their footprints at cell sizes from 1 to 200, with both
 * trees and fronts, at each of `seeds`. The fast tier runs the first seed and
 * tests/slow/micro-park-promise.test.js all eight: the forty builds took 2.9 s (#807).
 */
export function assertPiecesAtSizes(seeds) {
  for (const size of [1, 2, 8, 40, 200]) for (const seed of seeds) {
    const cells = cellsOf(30, 30), input = { ...brief('field', seed, cells, [], { density: 1, hedges: 0.5 }), cellSize: size };
    input.zones = [{ tier: 3, bonus: 0, lootChance: 0, cells }];
    const result = buildRegion(input);
    assert.ok(result.elements.some(kind('front')) && result.elements.some(kind('tree')), `size ${size} seed ${seed} has both`);
    for (const element of result.elements) for (const { shape } of element.template.parts) {
      const box = bounds(shape);
      assert.ok(box.w > 0 && box.h > 0, `size ${size}: ${element.label} has area`);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= element.template.w + 1e-9 && box.y + box.h <= element.template.h + 1e-9, `size ${size}: ${element.label} stays in its footprint`);
    }
  }
}
