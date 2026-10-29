import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { elementShapes, shapesOverlap } from '../../map/micro/geometry.ts';
import { validatePortalReach } from '../../map/micro/portals.ts';
import { rect } from '../../shared/shape.ts';
import { SIZE, MASKS, PARAMETERS, brief, build, blockers, ringElements, compoundBox } from './compound-fixtures.js';

/**
 * micro-compound's checks over every mask and gate count at each of `seeds`. Together they cost
 * 64 cases at four seeds, the portal check's reach searches about half of that, so the fast
 * tier runs one seed and `tests/slow/micro-compound-sweeps.test.js` the first four (31, #543).
 */
function forEachCase(seeds, check) {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of seeds) for (const parameters of PARAMETERS)
    check(name, seed, parameters, brief(name, seed, cells, portals, parameters));
}

export function assertPortalPromise(seeds) {
  forEachCase(seeds, (name, seed, parameters, input) => {
    const result = build(input);
    assert.ok(result.manifest.rooms >= 4, `${name} seed ${seed} stood a compound`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed} ${JSON.stringify(parameters)}`);
  });
}

export function assertRoofedRing(seeds) {
  forEachCase(seeds, (name, seed, parameters, input) => {
    const result = build(input), box = compoundBox(result);
    assert.ok(box.w >= 10 && box.h >= 10 && box.w <= 24 && box.h <= 24, `${name} ${seed}: ${box.w} × ${box.h}`);
    const court = rect((box.x + 3) * SIZE, (box.y + 3) * SIZE, (box.w - 6) * SIZE, (box.h - 6) * SIZE);
    assert.ok(result.elements.flatMap(element => elementShapes(element, true)).every(shape => !shapesOverlap(court, shape)), `${name} ${seed}: clear court`);
    const gates = ringElements(result).filter(element => element.label.startsWith('compound-gate'));
    assert.equal(gates.length, parameters?.gates ?? 2);
    assert.equal(result.manifest.compoundGates, gates.length);
    for (const room of ringElements(result).filter(element => element.label.startsWith('compound-room'))) {
      assert.equal(room.template.encloses, true);
      assert.ok(room.template.parts.some(part => part.part === 'gate'), `${room.label} has a door`);
    }
  });
}

export function assertObservedRing(seeds) {
  forEachCase(seeds, (name, seed, parameters, input) => {
    const traces = [];
    const result = buildRegion(input, undefined, trace => traces.push(trace));
    assert.deepEqual(result, build(input), `${name} ${seed}: observing changes nothing`);
    assert.equal(traces.length, 1);
    const [{ label, design, allocation, realization, origin }] = traces;
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
