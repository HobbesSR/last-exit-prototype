import test from 'node:test';
import assert from 'node:assert/strict';
import { OWN_FILE, briefs, byType, checkLargeBriefs } from '../helpers/large-briefs.js';

/**
 * What builders make of the briefs only the larger authored sizes hand them (#821): for each
 * type whose larger-size briefs exceed the full sweep's 12 × 6 maximum (12 of 17 at the #849 capture),
 * the 24 × 12 or 36 × 18 brief with the most portals or cells (`tools/large-briefs.mjs`,
 * tests/fixtures README). The root `map-library-24` and `-36*` files used to build five whole maps a size for this, at about
 * 85% of their 353 s; macro at those sizes is pinned by the chain sweep's `macro-*` cases
 * (tests/slow/map-macro-sizes.test.js), and composing and reporting run at 12 × 6.
 *
 * The claims are the ones those maps' reports made of a region: it builds, keeps its geometry
 * in the fill and counts every cell. None of these briefs asks for a core element (the core
 * element types are no larger at the larger sizes), so the core count check reads zero; the
 * game-size library maps and the builder contract cover siting. The portal
 * promise is left to the type's own files and the sweep's diagnosis: on these briefs the
 * thorough search costs up to 80 s where the build costs one. Park's brief is checked in
 * tests/slow/micro-large-briefs-park.test.js, to keep each file under 60 s (#849).
 */
for (const [type, entries] of byType) if (!OWN_FILE.has(type)) test(`large briefs: ${type} builds what the larger sizes hand it`, () => checkLargeBriefs(type, entries));

test('the stored briefs are the larger sizes\' extremes, at least one per type that has them', () => {
  assert.ok(byType.size >= 10, `${byType.size} types`);
  for (const { axes } of briefs) for (const { value, sweepMax } of Object.values(axes)) assert.ok(value > sweepMax);
});
