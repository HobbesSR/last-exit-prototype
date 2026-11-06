import assert from 'node:assert/strict';
import { buildRegion } from '../../map/micro/region-types.ts';
import { createAccessMask, elementShapes, findRegionRoutes, shapesOverlap } from '../../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../../map/micro/portals.ts';
import { microMetrics } from '../../map/micro/metrics.ts';
import { circle, rect } from '../../shared/shape.ts';
import { SIZE, MASKS, PARAMETERS, SEEDS, brief, build, observed, blockers, ringElements, cellBox, compoundBox } from './compound-fixtures.js';

/**
 * The fast tier's witnesses (31, #807): each mask once at the default two gates, and each other
 * gate count once. Builds are the cost here (0.5 to 1.4 s each on the field, ell and ring, about
 * 10 ms on the yard), so one and three gates go on the yard. Four gates go on the ell, where the
 * concave corner leaves no fourth gate stand until the ring steps down from 18 × 22 to 16 × 20
 * (siting rejects the larger boxes for insufficient-gate-stands): the cheapest mask that shows a
 * gate count resizing the ring.
 */
export const FAST_CASES = [
  ...Object.keys(MASKS).map(name => ({ name, seed: SEEDS[0], parameters: undefined })),
  ...PARAMETERS.filter(Boolean).map(parameters =>
    ({ name: parameters.gates === 4 ? 'ell' : 'yard', seed: SEEDS[0], parameters })),
];

/**
 * The slow tier's cases (`tests/slow/micro-compound-sweeps.test.js`, #822): every mask at every
 * gate count once, the seed rotating over 2 to 4 so that each mask and each gate count meets all
 * three. A seed moves the gate sides, the room count and, on the ell and ring, where the ring
 * stands; the ring's size follows the mask and gate count. Each build checks every claim, so the
 * full mask × gate × seed product repeated them at four times the cost.
 */
export const SLOW_CASES = Object.keys(MASKS).flatMap((name, m) =>
  PARAMETERS.map((parameters, p) => ({ name, seed: SEEDS[1 + (m + p) % 3], parameters })));

function forEachCase(cases, check) {
  for (const { name, seed, parameters } of cases) {
    const [cells, portals] = MASKS[name];
    check(`${name} seed ${seed} ${JSON.stringify(parameters ?? {})}`, parameters, brief(name, seed, cells, portals, parameters));
  }
}

export function assertPortalPromise(cases) {
  forEachCase(cases, (at, parameters, input) => {
    const result = build(input);
    assert.ok(result.manifest.rooms >= 4, `${at} stood a compound`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], at);
  });
}

export function assertRoofedRing(cases) {
  forEachCase(cases, (at, parameters, input) => {
    const result = build(input), box = compoundBox(result);
    assert.ok(box.w >= 10 && box.h >= 10 && box.w <= 24 && box.h <= 24, `${at}: ${box.w} × ${box.h}`);
    const court = rect((box.x + 3) * SIZE, (box.y + 3) * SIZE, (box.w - 6) * SIZE, (box.h - 6) * SIZE);
    assert.ok(ringElements(result).flatMap(element => elementShapes(element, true)).every(shape => !shapesOverlap(court, shape)), `${at}: ring leaves its court clear`);
    const gates = ringElements(result).filter(element => element.label.startsWith('compound-gate'));
    assert.equal(gates.length, parameters?.gates ?? 2);
    assert.equal(result.manifest.compoundGates, gates.length);
    for (const room of ringElements(result).filter(element => element.label.startsWith('compound-room'))) {
      assert.equal(room.template.encloses, true);
      assert.ok(room.template.parts.some(part => part.part === 'gate'), `${room.label} has a door`);
    }
  });
}

/**
 * The ring is one design, read from the trace of the shared build. With `unobserved`, the fast
 * tier's default, an unobserved build is compared with it: observing changes nothing. The slow
 * tier leaves that to the fast cases, since it is a property of the observer hook and not of a
 * seed, and the second build doubled the slow sweep (#822).
 */
export function assertObservedRing(cases, { unobserved = true } = {}) {
  forEachCase(cases, (at, parameters, input) => {
    const { result, traces } = observed(input);
    if (unobserved) assert.deepEqual(buildRegion(input), result, `${at}: observing changes nothing`);
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
    for (const space of design.spaces) assert.ok(realization.openings.some(o => o.a === space.id || o.b === space.id), `${at}: ${space.id} has an opening`);
  });
}

/** Cell centres inside `box` (in cells) where a body of `radius` stands clear of `shapes`, nearest `to` first. */
function openPoints(box, shapes, radius, to) {
  const points = [];
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const point = { x: (x + 0.5) * SIZE, y: (y + 0.5) * SIZE }, body = circle(point.x, point.y, radius);
    if (shapes.every(shape => !shapesOverlap(body, shape))) points.push(point);
  }
  const far = point => Math.hypot(point.x - to.x, point.y - to.y);
  return points.sort((a, b) => far(a) - far(b));
}

/**
 * Every room and the court are open from the region's first portal through the compound's
 * gates: a hunter reaches the open point nearest each room's centre, and a contestant the open
 * points nearest the court's centre and corners. Topology alone (each space has an opening) is
 * `assertObservedRing`'s; this is the bodies getting there.
 */
export function assertRoomsAndCourtReached(cases) {
  const hunter = hunterClearance(SIZE), contestant = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).clearance.contestant;
  forEachCase(cases, (at, parameters, input) => {
    const result = build(input), shapes = blockers(result), access = createAccessMask(input);
    const from = portalStands(input)[0].points[0];
    const rooms = ringElements(result).filter(element => element.label.startsWith('compound-room'));
    const roomPoints = rooms.map(room => {
      const box = cellBox(room), point = openPoints(box, shapes, hunter, { x: (box.x + box.w / 2) * SIZE, y: (box.y + box.h / 2) * SIZE })[0];
      assert.ok(point, `${at}: ${room.label} has room to stand`);
      return point;
    });
    findRegionRoutes(access, shapes, from, roomPoints, hunter).forEach((route, i) =>
      assert.ok(route, `${at}: a hunter reaches ${rooms[i].label} at ${roomPoints[i].x},${roomPoints[i].y}`));
    const box = compoundBox(result), court = { x: box.x + 3, y: box.y + 3, w: box.w - 6, h: box.h - 6 };
    const aims = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => ({ x: (court.x + u * court.w) * SIZE, y: (court.y + v * court.h) * SIZE }));
    const courtPoints = [...new Map(aims.map(aim => openPoints(court, shapes, contestant, aim)[0]).filter(Boolean)
      .map(point => [`${point.x},${point.y}`, point])).values()];
    assert.ok(courtPoints.length, `${at}: the court has room to stand`);
    findRegionRoutes(access, shapes, from, courtPoints, contestant).forEach((route, i) =>
      assert.ok(route, `${at}: a contestant reaches the court at ${courtPoints[i].x},${courtPoints[i].y}`));
  });
}
