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
/** The parameter sets the promise runs under: the defaults, dense, fronts only, and sparse trees without hedges. */
export const PARAMETERS = [undefined, DENSE, { density: 0, hedges: 1 }, { density: 0.3, hedges: 0 }];
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

/** Every mask under `parameters` at each of `seeds`. */
export const casesAt = (seeds, parameters) => Object.keys(MASKS).flatMap(name => seeds.map(seed => ({ name, seed, parameters })));

/** The fast tier's promise cases (tests/micro-park.test.js): every mask under every parameter set at the first seed. */
export const FAST_CASES = PARAMETERS.flatMap(parameters => casesAt(SEEDS.slice(0, 1), parameters));

/**
 * The slow tier's cases (tests/slow/micro-park-promise.test.js, #822): every mask under every
 * parameter set once more, the seed rotating over 2 to 5 so that each mask and each parameter set
 * meets all four. Nine of the sixteen place trees (the tile and the fronts-only set place none), so the
 * dense tree-bearing depth is one seed per mask. A seed moves where clumps and fronts fall and how many there are; each build
 * checks every claim, so the full mask × parameter × seed product (128 builds, 23 s) repeated the
 * same claims eight times over.
 */
export const SLOW_CASES = Object.keys(MASKS).flatMap((name, m) =>
  PARAMETERS.map((parameters, p) => ({ name, seed: SEEDS[1 + (m + p) % 4], parameters })));

const label = ({ name, seed, parameters }) => `${name} seed ${seed} ${JSON.stringify(parameters ?? {})}`;

/** A park keeps the portal promise in each case, under the thorough search. */
export function assertParkPromise(cases) {
  for (const at of cases) {
    const result = built(at.name, at.seed, at.parameters);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) }, THOROUGH);
    assert.deepEqual(check.errors, [], label(at));
  }
}

/**
 * Clumps keep an aisle from each other and respect portal margins in each case. The fast tier
 * reads every mask's dense park at two seeds, the slow tier its sixteen cases. More than one
 * clump a case on average keeps the check from passing on empty parks.
 */
export function assertClumpSpacing(cases) {
  // Hedge runs gave way to fronts in #760; fronts are tested in micro-park-fronts.
  let clumps = 0;
  for (const at of cases) {
    const [cells, portals] = MASKS[at.name];
    const input = brief(at.name, at.seed, cells, portals, at.parameters);
    const result = built(at.name, at.seed, at.parameters), mask = createRegionMask(input);
    const reserved = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
    const trees = result.elements.filter(kind('tree')).map(boxOf);
    clumps += result.manifest.clumps;
    for (const tree of trees) for (let y = tree.y; y < tree.y + tree.h; y++) for (let x = tree.x; x < tree.x + tree.w; x++)
      assert.ok(mask.has(x, y) && !reserved.has(`${x},${y}`), `${label(at)}: tree footprint`);
    // Trees in different clumps keep their aisle: any two closer than it are in one clump (a slot's band).
    for (const [i, a] of trees.entries()) for (const b of trees.slice(i + 1))
      if (gapBetween(a, b) < 2) assert.ok(Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4, `${label(at)}: trees ${a.x},${a.y} and ${b.x},${b.y}`);
  }
  assert.ok(clumps > cases.length, `${clumps} clumps in ${cases.length} cases`);
}

/**
 * Pieces keep valid geometry inside their footprints at cell sizes from 1 to 200, with both
 * trees and fronts. The fast tier runs every size at the first seed and
 * tests/slow/micro-park-promise.test.js each size once more at a rotating seed (#807, #822).
 */
export const SIZE_CASES = { fast: [1, 2, 8, 40, 200].map(size => ({ size, seed: SEEDS[0] })),
  slow: [1, 2, 8, 40, 200].map((size, i) => ({ size, seed: SEEDS[1 + i] })) };
export function assertPiecesAtSizes(cases) {
  for (const { size, seed } of cases) {
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

/**
 * A park is its own type: only tree and hedge obstacles, counted in its manifest, and no
 * structures, in each case. The fast tier reads the dense field at seeds 1 and 2, the builds the
 * clump sweep shares, and the slow tier its sixteen cases. More than four trees a case on average
 * (the sixteen gave 94, the two dense fields 31) keeps the check from passing on a thinned park; how many trees a park holds is stand-in content,
 * not a claim (17.2.11).
 */
export function assertParkKinds(cases) {
  let trees = 0, fronts = 0;
  for (const at of cases) {
    const result = built(at.name, at.seed, at.parameters);
    for (const element of result.elements) for (const part of element.template.parts) {
      assert.equal(part.part, 'obstacle');
      assert.equal(part.kind, element.label.startsWith('park-tree') ? 'tree' : 'hedge');
    }
    trees += result.elements.filter(kind('tree')).length;
    fronts += result.elements.filter(kind('front')).length;
    assert.equal(result.manifest.trees, result.elements.filter(kind('tree')).length, label(at));
    assert.equal(result.manifest.fronts, result.elements.filter(kind('front')).length, label(at));
    assert.equal(result.manifest.structures, 0, label(at));
  }
  assert.ok(trees > 4 * cases.length && fronts > cases.length, `${trees} trees, ${fronts} fronts in ${cases.length} cases`);
}
