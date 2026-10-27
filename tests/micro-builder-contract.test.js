import test from 'node:test';
import assert from 'node:assert/strict';
import { REGION_TYPES, buildRegion } from '../map/micro/region-types.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { validateFillConstraints } from '../map/micro/margins.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { compareCells } from '../map/kernel/cell.ts';
import { chainBrief, chainFixtures, reorderedBrief } from './helpers/chain-briefs.js';
import { MASKS } from './helpers/plant-fixtures.js';

/**
 * What every registered builder owes any brief the chain can hand it (20.6, 20.9), run over
 * chain-like fixtures (`tests/helpers/chain-briefs.js`): cleared strips inside the owned
 * cells, concave and holed masks, many portals, hints, a playable area past the owned cells.
 * A builder under development runs only its own type, in seconds:
 *
 *   node --test --test-name-pattern=plant tests/micro-builder-contract.test.js
 *
 * `BUILDER_SEEDS=<n>` runs seeds 1 to `n` on each fixture instead of `SEEDS`, a deeper sweep
 * for a builder change (31). Seeds 1 to 20 took about 70 s across every type.
 *
 * Budget (31: 15 s fast tier): six fixtures of 224 to 660 cells at `SEEDS` seeds each, two
 * builds a case (the second in another cell order), then #490's 120 plant builds. On the shared
 * dev machine, with other agents' work and a dev server running, three sequential runs took
 * 8.7 to 8.8 s: 6.6 s for the types and 1.9 s for #490. A run during a heavier spell took 14 s,
 * so the margin under 15 s is thin when the machine is busy. A build's cost grows
 * faster than its region's cells (a 40 × 30 region cost five times a 24 × 18), so the
 * fixtures' sizes are what keep the seventeen types affordable. `npm run test:times` checks.
 */
const SEEDS = 2;
const seedCount = (() => {
  const text = process.env.BUILDER_SEEDS;
  if (text === undefined) return SEEDS;
  if (!/^[1-9]\d{0,3}$/.test(text)) throw new RangeError(`BUILDER_SEEDS must be a whole number from 1 to 9999, not "${text}".`);
  return Number(text);
})();

/**
 * Parameters that make a type use its features on every fixture instead of by chance, so a
 * fixture that never meets a feature cannot pass for having met it. Types absent here have
 * none that thins their content.
 */
const FORCED = {
  plant: { density: 1, shed: 0 },
  depot: { density: 1 },
  park: { density: 1, hedges: 1 },
  rubble: { density: 1 },
  ruins: { density: 1 },
  cover: { density: 1 },
  compound: { gates: 4 },
  hall: { roofed: true },
};

/** The core elements a type sites, requested as the chain's class rule would (51 "Core elements"). */
const CORE = {
  arrival: { spawn: 3 },
  departure: { exit: 1, 'hunter-spawn': 1 },
  charging: { charger: 1 },
  transit: { warp: 1 },
};

/** Types that build no geometry by design: `open` is empty ground and offers no loot (20.6). */
const BUILDS_NOTHING = new Set(['open']);

/** What a build is, apart from the brief it echoes: what must not change with the brief's cell order. */
const content = result => JSON.stringify({ elements: result.elements, coreElements: result.coreElements, loot: result.loot, manifest: result.manifest });

/** Build a brief and check the cheap promises: it builds, and its geometry stays in the fill area. */
function build(brief) {
  let result;
  try {
    result = buildRegion(brief);
  } catch (error) {
    return { found: [`throws: ${error.message}`] };
  }
  const fill = validateFillConstraints(result.brief, result.elements.flatMap(e => elementShapes(e, true)));
  return { result, found: fill.length ? [`leaves the allowed fill area: ${fill.join(' ')}`] : [] };
}

/** The result, and the problems one build has: empty when it keeps every promise a builder owes. */
function check(type, brief) {
  const { result, found } = build(brief);
  if (!result) return { found };
  const reach = validatePortalReach({ ...result.brief, blockers: result.elements.flatMap(e => elementShapes(e)) }).errors;
  if (reach.length) found.push(`breaks the portal promise: ${reach.join(' ')}`);
  if (result.manifest.cells !== brief.cells.length) found.push(`manifest counts ${result.manifest.cells} cells of ${brief.cells.length}`);
  const asked = Object.values(CORE[type] ?? {}).reduce((sum, count) => sum + count, 0);
  if (result.coreElements.length !== asked) found.push(`sites ${result.coreElements.length} of ${asked} core elements`);
  // The second build must equal the first. If it doesn't, a third on the original brief says why.
  if (!found.length) {
    try {
      if (content(buildRegion(reorderedBrief(brief, brief.seed))) !== content(result)) found.push(content(buildRegion(brief)) === content(result)
        ? 'builds differently when the brief lists its cells in another order' : 'builds differently each time from the same brief');
    } catch (error) {
      found.push(`throws on the same cells in another order: ${error.message}`);
    }
  }
  return { result, found };
}

for (const type of Object.keys(REGION_TYPES)) {
  test(`builder contract: ${type}`, () => {
    const found = [], built = new Set();
    let cases = 0;
    for (const fixture of chainFixtures()) for (let seed = 1; seed <= seedCount; seed++) {
      const brief = chainBrief({ ...fixture, id: `${type}-${fixture.name}`, seed, type, parameters: FORCED[type], coreElements: CORE[type] });
      const checked = check(type, brief);
      for (const problem of checked.found) found.push(`${fixture.name}, seed ${seed}: ${problem}`);
      if (checked.result?.elements.length) built.add(fixture.name);
      cases++;
    }
    assert.deepEqual(found, [], `${cases} builds`);
    // A fixture a type builds nothing on proves nothing about it. The roomy ones hold every type's content.
    if (!BUILDS_NOTHING.has(type)) for (const { name, roomy } of chainFixtures())
      if (roomy) assert.ok(built.has(name), `${type} built no geometry on ${name}: the fixture no longer exercises it`);
  });
}

test('a reordered brief lists the same cells in another order, so the order check is not vacuous', () => {
  const ordered = list => list.slice().sort(compareCells);
  for (const fixture of chainFixtures()) {
    const brief = chainBrief(fixture), other = reorderedBrief(brief, 1);
    for (const list of ['cells', 'fillCells', 'clearCells']) {
      assert.notDeepEqual(other[list], brief[list], `${fixture.name} ${list}`);
      assert.deepEqual(ordered(other[list]), ordered(brief[list]), `${fixture.name} ${list}`);
    }
    assert.deepEqual(other.portals, brief.portals, fixture.name);
  }
});

// #490: a pipe run's addressed area once reached a cell inside the access mask and outside
// the fill mask, where a cleared strip crosses the gap between two machines. Only the
// 224-map chain sweep found it, on one map. Strips across a plant's aisles at three offsets,
// with every slot taken and no shed, reproduce it: with the gap addressed again, 15 of these
// 120 builds throw (6 with the horizontal strips alone); with the fix, none do.
test('plant: cleared strips crossing the aisles between its slots build (#490)', () => {
  const [cells, portals] = MASKS.field;
  const found = [];
  for (const y of [6, 13, 21]) for (let seed = 1; seed <= 40; seed++) {
    const brief = chainBrief({ id: `strip-${y}`, seed, type: 'plant', cells, portals, parameters: { density: 1, shed: 0 },
      internal: [{ axis: 'h', x: 0, y, length: 40 }, { axis: 'v', x: 11 + y, y: 0, length: 30 }] });
    for (const problem of build(brief).found) found.push(`strip y ${y}, seed ${seed}: ${problem}`);
  }
  assert.deepEqual(found, [], '120 builds');
});
