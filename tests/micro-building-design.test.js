import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTSIDE, validateBuildingDesign, deriveBuildingBoundaries, placeBuildingOpenings, realizeBuilding, splitBuilding, createRegionMask, elementShapes } from '../map/micro/sdk.ts';

const cellsOf = (w, h, keep = () => true) => Array.from({ length: w * h }, (_, i) => ({ x: i % w, y: Math.floor(i / w) })).filter(c => keep(c.x, c.y));
const space = id => ({ id, area: { min: 1, max: 100 }, outside: 'prefer', tags: ['guidance'] });
const designOf = (ids = ['room'], connections = []) => ({ spaces: ids.map(space), connections });
const allocationOf = cells => ({ footprint: cells, spaces: [{ id: 'room', cells }] });
const connection = (id, kind = 'door', extra = {}) => ({ id, a: 'room', b: OUTSIDE, kind, ...extra });
const end = (run, forward) => forward
  ? [run.x + (run.axis === 'h' ? run.length : 0), run.y + (run.axis === 'v' ? run.length : 0)] : [run.x, run.y];
const start = (run, forward) => end(run, !forward);

function checkSpans(boundaries) {
  for (const pair of boundaries) {
    assert.equal(pair.spans.flatMap(span => span.steps).length, pair.runs.length, 'every run occurs once');
    assert.equal(new Set(pair.spans.flatMap(span => span.steps.map(step => JSON.stringify(step.run)))).size, pair.runs.length);
    for (const span of pair.spans) {
      span.steps.slice(1).forEach((step, i) => assert.deepEqual(start(step.run, step.forward), end(span.steps[i].run, span.steps[i].forward)));
      if (span.closed) assert.deepEqual(start(span.steps[0].run, span.steps[0].forward), end(span.steps.at(-1).run, span.steps.at(-1).forward));
    }
  }
}

test('building design validation rejects broken identities and obsolete connection kinds', () => {
  const design = designOf(['room', 'hall'], [connection('entry'), connection('join', 'open', { b: 'hall' }), connection('view', 'window')]);
  assert.deepEqual(validateBuildingDesign(design), []);
  for (const invalid of [
    { ...design, spaces: [space('room'), space('room')] },
    { ...design, spaces: [space(OUTSIDE)] },
    { ...design, connections: [connection('missing', 'door', { b: 'unknown' })] },
    { ...design, connections: [connection('same'), connection('same')] },
    { ...design, connections: [connection('self', 'door', { b: 'room' })] },
    { ...design, connections: [connection('interior-side', 'open', { b: 'hall', side: 'E' })] },
    { ...design, connections: [connection('obsolete', 'squeeze')] },
    { ...design, connections: [connection('obsolete', 'wall')] },
    { spaces: [{ ...space('room'), area: { min: 3, max: 2 } }], connections: [] },
  ]) assert.ok(validateBuildingDesign(invalid).length);
  // Disconnected intent and labels do not impose a reachability or area contract.
  assert.deepEqual(validateBuildingDesign(designOf(['isolated', 'unrealized'])), []);
});

test('an L-shaped space has a closed ordered span around its concavity', () => {
  const cells = cellsOf(5, 5, (x, y) => x < 2 || y < 2), boundaries = deriveBuildingBoundaries(allocationOf(cells));
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].spans.length, 1);
  assert.equal(boundaries[0].spans[0].closed, true);
  assert.equal(boundaries[0].runs.length, 6);
  assert.equal(boundaries[0].runs.reduce((sum, run) => sum + run.length, 0), 20);
  checkSpans(boundaries);
});

test('a ring has separate inner and outer spans against the same outside owner', () => {
  const cells = cellsOf(6, 6, (x, y) => x < 2 || x >= 4 || y < 2 || y >= 4), boundaries = deriveBuildingBoundaries(allocationOf(cells));
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].spans.length, 2);
  assert.ok(boundaries[0].spans.every(span => span.closed));
  assert.deepEqual(boundaries[0].spans.map(span => span.steps.reduce((sum, step) => sum + step.run.length, 0)).sort((a, b) => a - b), [8, 24]);
  checkSpans(boundaries);
  assert.deepEqual(deriveBuildingBoundaries(allocationOf([...cells].reverse())), boundaries, 'cell order has no effect');
});

test('side-by-side spaces share exactly one wall and each has an exterior span', () => {
  const cells = cellsOf(8, 4), allocation = { footprint: cells, spaces: [
    { id: 'a', cells: cells.filter(c => c.x < 4) }, { id: 'b', cells: cells.filter(c => c.x >= 4) },
  ] };
  const boundaries = deriveBuildingBoundaries(allocation), shared = boundaries.find(pair => pair.a === 'a' && pair.b === 'b');
  assert.equal(boundaries.length, 3);
  assert.deepEqual(shared.runs, [{ axis: 'v', x: 4, y: 0, length: 4 }]);
  assert.equal(shared.spans[0].closed, false);
  assert.ok(boundaries.every(pair => pair.spans.length === 1 && !pair.spans[0].closed));
  checkSpans(boundaries);
  const result = realizeBuilding(designOf(['a', 'b'], [{ id: 'join', a: 'a', b: 'b', kind: 'door' }]), allocation, { cellSize: 10 });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.misses, []);
  assert.equal(result.template.parts.filter(part => part.part === 'gate').length, 1);
  const internal = result.template.parts.filter(part => part.part === 'obstacle' && part.shape.x === 38.75);
  assert.equal(internal.length, 2, 'one shared wall cut by one doorway');
  assert.equal(internal.reduce((sum, part) => sum + part.shape.h, 0), 20);
});

test('unfitting, absent and occupied opening sites are reported without becoming design failures', () => {
  const cells = cellsOf(4, 4), boundaries = deriveBuildingBoundaries(allocationOf(cells));
  const design = designOf(['room', 'unrealized'], [
    connection('door', 'door', { side: 'N' }), connection('clash', 'window', { side: 'N' }),
    connection('missing', 'open', { b: 'unrealized' }), connection('too-wide', 'open', { side: 'S' }),
  ]);
  const result = placeBuildingOpenings(design, boundaries, { widths: { 'too-wide': 5 } });
  assert.deepEqual(result.misses, [
    { connectionId: 'clash', reason: 'overlap' }, { connectionId: 'missing', reason: 'no-boundary' }, { connectionId: 'too-wide', reason: 'no-fit' },
  ]);
  assert.equal(result.openings.length, 1);
  assert.equal(result.openings[0].center, 2);
  assert.equal(result.openings[0].length, 2);
  assert.equal(placeBuildingOpenings(designOf(['room'], [connection('constructor')]), boundaries, { widths: {} }).openings[0].length, 2,
    'connection ids do not read inherited width properties');
  const narrow = placeBuildingOpenings(designOf(['room'], [connection('door')]), deriveBuildingBoundaries(allocationOf(cellsOf(1, 1))));
  assert.deepEqual(narrow.misses, [{ connectionId: 'door', reason: 'no-fit' }], 'an opening cannot bend around corners');
  const trimmed = realizeBuilding(designOf(['room'], [connection('east', 'door', { side: 'E' })]), allocationOf(cellsOf(4, 2)),
    { cellSize: 40, corners: 'horizontal' });
  assert.deepEqual(trimmed.issues, []);
  assert.deepEqual(trimmed.misses, [{ connectionId: 'east', reason: 'no-fit' }]);
  assert.ok(trimmed.template, 'unfulfilled guidance remains a report, not a contract');
});

test('realization makes gates, windows and open passages and keeps pass outputs plain and immutable', () => {
  const cells = cellsOf(4, 4).map(c => ({ x: c.x - 7, y: c.y + 2 })), allocation = allocationOf(cells);
  const design = designOf(['room'], [connection('entry', 'door', { side: 'N' }), connection('view', 'window', { side: 'S' }), connection('passage', 'open', { side: 'E' })]);
  const before = structuredClone({ design, allocation });
  const result = realizeBuilding(design, allocation, { cellSize: 40, corners: 'horizontal' });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.misses, []);
  assert.deepEqual(result.origin, { x: -280, y: 80 });
  assert.equal(result.template.encloses, true);
  assert.equal(result.template.parts.filter(part => part.part === 'gate').length, 1);
  assert.equal(result.template.parts.filter(part => part.kind === 'window').length, 1);
  assert.equal(result.template.parts.at(-1).part, 'gate');
  const eastWalls = result.template.parts.filter(part => part.part === 'obstacle' && part.shape.x === 150);
  assert.deepEqual(eastWalls.map(part => [part.shape.y, part.shape.h]), [[10, 30], [120, 30]]);
  assert.deepEqual({ design, allocation }, before);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(realizeBuilding(design, { footprint: [...cells].reverse(), spaces: [{ id: 'room', cells: [...cells].reverse() }] }, { cellSize: 40, corners: 'horizontal' }), result);
});

test('concave, holed and diagonally touching footprints contain every emitted wall and refuse rectangular roofs', () => {
  for (const cells of [
    cellsOf(5, 5, (x, y) => x < 2 || y < 2),
    cellsOf(6, 6, (x, y) => x < 2 || x >= 4 || y < 2 || y >= 4),
    [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  ]) {
    const allocation = allocationOf(cells), design = designOf(), mask = createRegionMask({ cells, cellSize: 40 });
    for (const corners of ['overlap', 'horizontal']) {
      const result = realizeBuilding(design, allocation, { cellSize: 40, encloses: false, corners });
      assert.deepEqual(result.issues, []);
      assert.equal(result.template.encloses, false);
      for (const shape of elementShapes({ ...result.origin, template: result.template })) assert.ok(mask.contains(shape), JSON.stringify(shape));
      checkSpans(result.boundaries);
    }
    const roof = realizeBuilding(design, allocation, { cellSize: 40 });
    assert.equal(roof.template, undefined);
    assert.match(roof.issues.join(' '), /rectangular roof/);
  }
});

test('concave corners are owned by a wall rather than meeting at a point', () => {
  const t = 0.25, size = 40, covered = (result, x, y) => result.template.parts.some(part => part.part === 'obstacle'
    && part.shape.x < x * size && x * size < part.shape.x + part.shape.w && part.shape.y < y * size && y * size < part.shape.y + part.shape.h);
  for (const [cells, corners] of [
    [cellsOf(5, 5, (x, y) => x < 2 || y < 2), [[2 - t / 2, 2 - t / 2]]],
    [cellsOf(6, 6, (x, y) => x < 2 || x >= 4 || y < 2 || y >= 4), [[2 - t / 2, 2 - t / 2], [4 + t / 2, 2 - t / 2], [2 - t / 2, 4 + t / 2], [4 + t / 2, 4 + t / 2]]],
  ]) for (const mode of ['overlap', 'horizontal']) {
    const result = realizeBuilding(designOf(), allocationOf(cells), { cellSize: size, thickness: t, encloses: false, corners: mode });
    for (const [x, y] of corners) assert.ok(covered(result, x, y), `${mode} corner near ${x},${y}`);
  }
});

test('corner trims that consume a whole wall run are refused, not emitted', () => {
  const result = realizeBuilding(designOf(), allocationOf(cellsOf(1, 1)), { cellSize: 40, thickness: 1, encloses: true, corners: 'horizontal' });
  assert.match(result.issues.join(' '), /Corner trims consume a wall run/);
  assert.equal(result.template, undefined);
});

test('invalid ownership is reported before any template can escape its footprint', () => {
  const cells = cellsOf(4, 4), allocation = allocationOf(cells);
  for (const invalid of [
    { ...allocation, footprint: [] },
    { ...allocation, footprint: [...cells, cells[0]] },
    { ...allocation, spaces: [{ id: 'room', cells: cells.slice(1) }] },
    { ...allocation, spaces: [{ id: 'room', cells: [...cells, { x: 9, y: 9 }] }] },
    { ...allocation, spaces: [{ id: 'room', cells }, { id: 'another', cells }] },
    { ...allocation, spaces: [{ id: 'missing', cells }] },
  ]) {
    const result = realizeBuilding(designOf(['room', 'another']), invalid, { cellSize: 40 });
    assert.ok(result.issues.length);
    assert.equal(result.template, undefined);
  }
});

test('openings sit on the half cell nearest their usable middle', () => {
  const design = designOf(['room'], [connection('entry', 'door', { side: 'E' })]);
  const cells = cellsOf(6, 6, (x, y) => x < 3 || y >= 3), allocation = allocationOf(cells);
  // The east run beside the notch is trimmed at its convex end only: 0.25 to 3, whose middle is 1.625.
  const result = realizeBuilding(design, allocation, { cellSize: 40, encloses: false, corners: 'horizontal' });
  assert.equal(result.openings[0].center % 0.5, 0);
  const odd = placeBuildingOpenings(design, deriveBuildingBoundaries(allocationOf(cellsOf(5, 3)))).openings[0];
  assert.equal(odd.center, 1.5, 'an odd run keeps its exact middle, already a half cell');
});

test('a clear space keeps its whole cells: a wall it shares stands in its neighbour', () => {
  const rooms = (x0, w) => cellsOf(8, 3).filter(c => c.x >= x0 && c.x < x0 + w);
  const allocation = { footprint: cellsOf(8, 3), spaces: [{ id: 'west', cells: rooms(0, 3) }, { id: 'lane', cells: rooms(3, 2) }, { id: 'east', cells: rooms(5, 3) }] };
  const design = designOf(['west', 'lane', 'east']);
  const walls = clear => realizeBuilding(design, allocation, { cellSize: 40, encloses: false, clear }).template.parts
    .filter(p => p.part === 'obstacle' && p.shape.h === 3 * 40).map(p => [p.shape.x / 40, p.shape.w / 40]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(walls([]).filter(([x]) => x > 1 && x < 6), [[2.875, 0.25], [4.875, 0.25]], 'interior walls straddle by default');
  assert.deepEqual(walls(['lane']).filter(([x]) => x > 1 && x < 6), [[2.75, 0.25], [5, 0.25]], 'the lane stays two cells clear');
  assert.deepEqual(walls(['west', 'lane', 'east']), walls([]), 'two clear spaces still straddle');
});

test('a realization splits into one element per space, roofing only rectangular spaces asked for', () => {
  const ring = cellsOf(9, 9, (x, y) => x < 3 || x >= 6 || y < 3 || y >= 6);
  const box = (x0, y0, w, h) => ring.filter(c => c.x >= x0 && c.x < x0 + w && c.y >= y0 && c.y < y0 + h);
  const spaces = [{ id: 'north', cells: box(0, 0, 9, 3) }, { id: 'west', cells: box(0, 3, 3, 3) }, { id: 'gap', cells: box(6, 3, 3, 3) }, { id: 'south', cells: box(0, 6, 9, 3) }];
  const allocation = { footprint: ring, spaces };
  const design = designOf(spaces.map(s => s.id), [connection('court', 'door', { a: 'north', side: 'S' }), connection('through', 'open', { a: 'gap', b: 'north' }),
    connection('mouth', 'open', { a: 'gap', side: 'W' })]);
  const realization = realizeBuilding(design, allocation, { cellSize: 40, encloses: false, widths: { mouth: 3 } });
  assert.deepEqual([realization.issues, realization.misses], [[], []]);
  assert.equal(realization.owners.length, realization.template.parts.length);
  const { pieces, issues } = splitBuilding(realization, allocation, { cellSize: 40, roofed: ['north', 'west', 'south'] });
  assert.deepEqual(issues, []);
  assert.deepEqual(pieces.map(p => [p.space, p.origin, p.template.w / 40, p.template.h / 40, !!p.template.encloses]),
    [['north', { x: 0, y: 0 }, 9, 3, true], ['west', { x: 0, y: 120 }, 3, 3, true], ['gap', { x: 240, y: 120 }, 3, 3, false], ['south', { x: 0, y: 240 }, 9, 3, true]]);
  assert.equal(pieces.reduce((n, p) => n + p.template.parts.length, 0), realization.template.parts.length, 'every part lands in one piece');
  // In world units the pieces together are the whole realization.
  const world = element => elementShapes(element, true).map(s => JSON.stringify(s)).sort();
  assert.deepEqual(pieces.flatMap(p => world({ x: p.origin.x, y: p.origin.y, template: p.template })).sort(),
    world({ x: realization.origin.x, y: realization.origin.y, template: realization.template }));
  // The mouth is open its whole length, so no wall stands on the gap's west side.
  assert.ok(!pieces[2].template.parts.some(p => p.part === 'obstacle' && p.shape.x === 0 && p.shape.h > p.shape.w));
  // A wall between a roofed and an unroofed space belongs to the roofed one.
  assert.ok(pieces[2].template.parts.every(p => p.part !== 'obstacle' || p.shape.y >= 0 && p.shape.y < 120 && p.shape.x >= 0));
  assert.deepEqual(splitBuilding(realization, { ...allocation, spaces: [...spaces.slice(0, 2), { id: 'gap', cells: [...box(6, 3, 3, 3), ...box(6, 6, 1, 1)] }] },
    { cellSize: 40, roofed: ['gap'] }).issues.length, 1, 'a roof needs a rectangle');
});
