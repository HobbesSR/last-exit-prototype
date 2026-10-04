import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTSIDE, validateBuildingDesign, deriveBuildingBoundaries, placeBuildingOpenings, realizeBuilding, createRegionMask, elementShapes } from '../map/micro/sdk.ts';

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
