import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRegion } from '../../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoute } from '../../map/micro/geometry.ts';
import { microMetrics } from '../../map/micro/metrics.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { standNear } from './stands.js';
import { briefOf, SIZE, MASKS } from './region-masks.js';

/** Depot fixtures shared by the fast tests/micro-depot*.test.js files and tests/slow/micro-depot-sweeps.test.js. */
export { SIZE };
export const brief = briefOf('depot');

/** A yard, a wide field, an L, and a ring around a hole, with portals on several sides (shared with plant and park). */
export { MASKS };
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
export const blockers = result => result.elements.flatMap(element => elementShapes(element));

/**
 * A depot keeps the portal promise on every mask at each of `seeds`, under each parameter set. The
 * fast tier's tests/micro-depot.test.js runs the first seed (12 builds) and
 * tests/slow/micro-depot-sweeps.test.js all eight: the 96 builds took about 7 s (#807).
 */
export function assertDepotPromise(seeds) {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds)
    for (const parameters of [undefined, { density: 1, roomCells: 6 }, { density: 0.3, roomCells: 12 }]) {
      const result = buildRegion(brief(name, seed, cells, portals, parameters));
      if (name !== 'yard') assert.ok(result.elements.length > 0, `${name} seed ${seed} stood warehouses or rows`);
      const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
      assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
    }
}

/**
 * Every depot aisle is open to a contestant: each loot site in the first warehouse (its doors and
 * shelves) and a sample outdoors are reachable, on every mask at each of `seeds` and both room
 * sizes. The fast tier's tests/micro-depot-access.test.js runs the first seed and
 * tests/slow/micro-depot-sweeps.test.js seeds 1 to 3: the 24 builds took about 4 s (#807).
 */
export function assertDepotAccess(seeds) {
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds)
    for (const roomCells of [6, 9]) {
      const input = brief(name, seed, cells, portals, { density: 1, roomCells }, 1);
      const result = buildRegion(input), access = createAccessMask(input);
      const shapes = result.elements.flatMap(element => elementShapes(element));
      const near = standNear(input);
      const first = result.elements.find(element => element.label.startsWith('depot-warehouse'));
      const indoors = first ? result.loot.filter(site => site.x > first.x && site.x < first.x + first.template.w
        && site.y > first.y && site.y < first.y + first.template.h) : [];
      if (first) assert.ok(indoors.length > 0, `${name} ${seed}: loot indoors`);
      const every = Math.ceil(result.loot.length / 8);
      for (const site of [...indoors, ...result.loot.filter((_, i) => i % every === 0)])
        assert.ok(findRegionRoute(access, shapes, near(site), site, radius), `${name} ${seed}: ${site.x},${site.y} is reachable`);
    }
}

// Production depot briefs (#787's rollout and before): row runs keep their coordinates, seed,
// margins, zones and portal order.
const expand = runs => runs.flatMap(([x, y, length]) => Array.from({ length }, (_, i) => ({ x: x + i, y })));
const witnessBrief = fixture => ({ ...fixture, cells: expand(fixture.cells), fillCells: expand(fixture.fillCells),
  clearCells: expand(fixture.clearCells), zones: fixture.zones.map(zone => ({ ...zone, cells: expand(zone.cells) })) });
export const WITNESSES = JSON.parse(readFileSync(new URL('../fixtures/micro-depot-routing.json', import.meta.url)))
  .map(fixture => ({ witness: fixture.witness, brief: witnessBrief(fixture) }));

/**
 * The witnesses' portals are reachable once the depot stands. The two 756- and 648-cell witnesses
 * (2 and 14) take about 0.6 s together and run in the fast tier; the two 1944-cell witnesses
 * (5 and 8) spend about 1.9 s each in the reach search and run in tests/slow/micro-depot-sweeps.test.js.
 */
export function assertWitnessReach(witnesses, build = fixture => buildRegion(fixture.brief)) {
  for (const fixture of witnesses) {
    const result = build(fixture), { witness } = fixture;
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, [], `seed ${witness}: portal reach`);
  }
}

