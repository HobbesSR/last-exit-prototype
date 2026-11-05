import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { elementShapes, shapesOverlap } from '../../map/micro/geometry.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { rect } from '../../shared/shape.ts';
import { SIZE, MASKS, PARAMETERS, SEEDS, brief, build, blockers, ringElements, compoundBox } from './compound-fixtures.js';

/**
 * Every mask at every gate count at each of `seeds`: the matrix the two
 * `tests/slow/micro-compound-sweeps*.test.js` files run at the first four seeds (31, #543).
 */
export const sweepCases = seeds => Object.keys(MASKS).flatMap(name => seeds.flatMap(seed =>
  PARAMETERS.map(parameters => ({ name, seed, parameters }))));

/**
 * The fast tier's witnesses (31, #807): each mask once at the default two gates, and each other
 * gate count once on the yard, the smallest mask, which holds all four. Builds are the cost here
 * (0.5 to 1.4 s each on the field, ell and ring, about 10 ms on the yard), so the large masks
 * carry the shape claims and the yard carries the gate counts.
 */
export const FAST_CASES = [
  ...Object.keys(MASKS).map(name => ({ name, seed: SEEDS[0], parameters: undefined })),
  ...PARAMETERS.filter(Boolean).map(parameters => ({ name: 'yard', seed: SEEDS[0], parameters })),
];

function forEachCase(cases, check) {
  for (const { name, seed, parameters } of cases) {
    const [cells, portals] = MASKS[name];
    check(name, seed, parameters, brief(name, seed, cells, portals, parameters));
  }
}

export function assertPortalPromise(cases) {
  forEachCase(cases, (name, seed, parameters, input) => {
    const result = build(input);
    assert.ok(result.manifest.rooms >= 4, `${name} seed ${seed} stood a compound`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
  });
}

export function assertRoofedRing(cases) {
  forEachCase(cases, (name, seed, parameters, input) => {
    const result = build(input), box = compoundBox(result);
    assert.ok(box.w >= 10 && box.h >= 10 && box.w <= 24 && box.h <= 24, `${name} ${seed}: ${box.w} × ${box.h}`);
    const court = rect((box.x + 3) * SIZE, (box.y + 3) * SIZE, (box.w - 6) * SIZE, (box.h - 6) * SIZE);
    assert.ok(ringElements(result).flatMap(element => elementShapes(element, true)).every(shape => !shapesOverlap(court, shape)), `${name} ${seed}: ring leaves its court clear`);
    const gates = ringElements(result).filter(element => element.label.startsWith('compound-gate'));
    assert.equal(gates.length, parameters?.gates ?? 2);
    assert.equal(result.manifest.compoundGates, gates.length);
    for (const room of ringElements(result).filter(element => element.label.startsWith('compound-room'))) {
      assert.equal(room.template.encloses, true);
      assert.ok(room.template.parts.some(part => part.part === 'gate'), `${room.label} has a door`);
    }
  });
}

export function assertObservedRing(cases) {
  forEachCase(cases, (name, seed, parameters, input) => {
    const traces = [];
    const result = buildRegion(input, undefined, trace => traces.push(trace));
    assert.deepEqual(result, build(input), `${name} ${seed}: observing changes nothing`);
    assert.equal(traces.filter(trace => trace.label === 'compound').length, 1);
    assert.ok(traces.every(trace => ['compound', 'compound-keep', 'compound-outbuilding'].includes(trace.label) && !trace.realization.issues.length));
    for (const label of ['compound-keep', 'compound-outbuilding'])
      assert.equal(traces.filter(t => t.label === label).length, result.elements.filter(e => e.label === label).length);
    const { label, design, allocation, realization, origin } = traces.find(trace => trace.label === 'compound');
    assert.equal(label, 'compound');
    assert.deepEqual(realization.misses, []);
    assert.deepEqual(ringElements(result).map(e => e.label), allocation.spaces.map(s => `compound-${s.id}`));
    assert.equal(design.spaces.filter(s => s.id.startsWith('room')).length, result.manifest.rooms);
    // The ring's footprint is the compound's box less its court.
    const box = compoundBox(result);
    assert.deepEqual(origin, { x: box.x * SIZE, y: box.y * SIZE });
    assert.equal(allocation.footprint.length, box.w * box.h - (box.w - 6) * (box.h - 6));
    for (const space of design.spaces) assert.ok(realization.openings.some(o => o.a === space.id || o.b === space.id), `${name} ${seed}: ${space.id} has an opening`);
  });
}

export function assertCompoundDeterminism(seeds) {
  const [cells, portals] = MASKS.field;
  for (const seed of seeds) {
    const result = build(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
  }
}
