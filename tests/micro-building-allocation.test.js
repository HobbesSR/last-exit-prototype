import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateBuilding, createRegionMask, elementShapes, findRegionRoute, OUTSIDE, realizeBuilding } from '../map/micro/sdk.ts';
import { microMetrics } from '../map/micro/metrics.ts';

const cellsOf = (width, height, keep = () => true) => Array.from({ length: width * height }, (_, i) =>
  ({ x: i % width, y: Math.floor(i / width) })).filter(cell => keep(cell.x, cell.y));
const room = (id, min = 9, max = 100, outside = 'any') => ({ id, area: { min, max }, outside });
const designOf = (ids = ['a', 'b']) => ({ spaces: ids.map(id => room(id)), connections: [] });
const key = cell => `${cell.x},${cell.y}`;
const neighbors = cell => [{ x: cell.x - 1, y: cell.y }, { x: cell.x + 1, y: cell.y },
  { x: cell.x, y: cell.y - 1 }, { x: cell.x, y: cell.y + 1 }];

function connected(cells) {
  if (!cells.length) return false;
  const all = new Set(cells.map(key)), seen = new Set([key(cells[0])]), queue = [cells[0]];
  for (const cell of queue) for (const next of neighbors(cell)) {
    const id = key(next);
    if (all.has(id) && !seen.has(id)) { seen.add(id); queue.push(next); }
  }
  return seen.size === all.size;
}

function patchCenters(cells) {
  const owned = new Set(cells.map(key));
  return cells.filter(cell => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
      if (!owned.has(`${cell.x + dx},${cell.y + dy}`)) return false;
    return true;
  });
}

function checkAllocation(result, design, footprint, maxSteps = 2000, maxSolutions = 16) {
  assert.equal(result.ok, true, result.reason);
  const expected = new Set(footprint.map(key));
  assert.equal(expected.size, footprint.length, 'fixture owns each cell once');
  assert.deepEqual(new Set(result.allocation.footprint.map(key)), expected);
  assert.deepEqual(new Set(result.allocation.spaces.map(space => space.id)), new Set(design.spaces.map(space => space.id)));
  const assigned = new Set();
  for (const allocated of result.allocation.spaces) {
    const specification = design.spaces.find(space => space.id === allocated.id);
    assert.ok(allocated.cells.length >= specification.area.min && allocated.cells.length <= specification.area.max);
    assert.ok(connected(allocated.cells), `${allocated.id} is connected`);
    const centers = patchCenters(allocated.cells);
    assert.ok(centers.length, `${allocated.id} has a 3x3 patch`);
    assert.ok(connected(centers), `${allocated.id} has connected 3x3 patch centers`);
    const covered = new Set(centers.flatMap(c => Array.from({ length: 9 }, (_, i) =>
      `${c.x + i % 3 - 1},${c.y + Math.floor(i / 3) - 1}`)));
    assert.ok(allocated.cells.every(cell => covered.has(key(cell))), `${allocated.id} has no thin tail`);
    for (const cell of allocated.cells) {
      assert.ok(expected.has(key(cell)), `assigned cell ${key(cell)} belongs to the footprint`);
      assert.ok(!assigned.has(key(cell)), `cell ${key(cell)} has one owner`);
      assigned.add(key(cell));
    }
  }
  assert.deepEqual(assigned, expected);
  assert.equal(result.search.optimal, false);
  assert.ok(result.search.steps > 0 && result.search.steps <= maxSteps);
  assert.ok(result.search.solutions > 0 && result.search.solutions <= maxSolutions);
  assert.equal(typeof result.search.budgetExhausted, 'boolean');
  assert.equal(typeof result.scoreComponents.connections, 'number');
  assert.equal(typeof result.scoreComponents.outside, 'number');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  return result;
}

function spaceCells(result, id) {
  return result.allocation.spaces.find(space => space.id === id).cells;
}

function boundsOf(cells) {
  return { x0: Math.min(...cells.map(cell => cell.x)), x1: Math.max(...cells.map(cell => cell.x)),
    y0: Math.min(...cells.map(cell => cell.y)), y1: Math.max(...cells.map(cell => cell.y)) };
}

function checkRealization(result, footprint) {
  const built = realizeBuilding(result.design, result.allocation, { cellSize: 40, encloses: false });
  assert.deepEqual(built.issues, []);
  assert.ok(built.template);
  assert.deepEqual(built.openings, result.openings);
  const mask = createRegionMask({ cells: footprint, cellSize: 40 });
  const blockers = elementShapes({ ...built.origin, template: built.template });
  for (const shape of blockers) assert.ok(mask.contains(shape), `wall ${JSON.stringify(shape)} stays in footprint`);
  return { mask, blockers };
}

function checkInteriorAccess(result, mask, blockers) {
  const radius = microMetrics({ cellSize: 40, bodyProfile: 'cell' }).clearance.hunter;
  const point = allocated => {
    const center = patchCenters(allocated.cells)[0];
    return { x: (center.x + 0.5) * 40, y: (center.y + 0.5) * 40 };
  };
  const root = point(result.allocation.spaces[0]);
  for (const allocated of result.allocation.spaces.slice(1))
    assert.ok(findRegionRoute(mask, blockers, root, point(allocated), radius), `hunter reaches ${allocated.id}`);
}

test('allocation covers rectangles and concave footprints with usable connected rooms', () => {
  const cases = [
    ['rectangle', cellsOf(9, 6), designOf(['a', 'b'])],
    ['L', cellsOf(9, 9, (x, y) => x < 5 || y < 5), designOf(['a', 'b'])],
    ['notch', cellsOf(10, 8, (x, y) => x < 6 || y >= 3), designOf(['a', 'b'])],
  ];
  for (const [name, footprint, design] of cases) for (const seed of [0, 3, 7]) {
    const result = checkAllocation(allocateBuilding(design, footprint, { seed }), design, footprint);
    const { mask, blockers } = checkRealization(result, footprint);
    checkInteriorAccess(result, mask, blockers);
    assert.ok(result.openings.some(opening => opening.a !== OUTSIDE && opening.b !== OUTSIDE
      && opening.kind !== 'window'), `${name} seed ${seed} joins rooms`);
  }
});

test('canonical ordering, plain-data roundtrip, and input immutability', () => {
  const footprint = cellsOf(8, 6).map(cell => ({ x: cell.x - 4, y: cell.y + 11 }));
  const design = { spaces: [room('a'), room('b')], connections: [
    { id: 'view', a: 'a', b: OUTSIDE, kind: 'window', side: 'N' },
    { id: 'entry', a: 'b', b: OUTSIDE, kind: 'door', side: 'S' },
  ] };
  const before = structuredClone({ design, footprint });
  const first = allocateBuilding(design, footprint, { seed: 4 });
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual(allocateBuilding(design, [...footprint].reverse(), { seed: 4 }), first);
  assert.deepEqual(allocateBuilding({ spaces: [...design.spaces].reverse(), connections: [...design.connections].reverse() }, footprint, { seed: 4 }), first);
  assert.deepEqual(allocateBuilding(design, footprint, { seed: 4 }), first);
  assert.deepEqual({ design, footprint }, before);
  const saved = JSON.parse(JSON.stringify(first));
  assert.deepEqual(saved, first);
  checkRealization(saved, footprint);
});

test('supplemental interior doors connect empty, window-only, and disconnected design graphs', () => {
  const footprint = cellsOf(9, 6);
  for (const design of [
    designOf(['a', 'b']),
    { spaces: [room('a'), room('b')], connections: [{ id: 'view', a: 'a', b: 'b', kind: 'window' }] },
    { spaces: [room('a'), room('b'), room('c')], connections: [{ id: 'ab', a: 'a', b: 'b', kind: 'door' }] },
  ]) {
    const result = checkAllocation(allocateBuilding(design, footprint, { seed: 2 }), design, footprint);
    const original = new Set(design.connections.map(connection => connection.id));
    const supplemental = result.design.connections.filter(connection => !original.has(connection.id));
    assert.ok(supplemental.length, 'missing traversable links are added');
    assert.ok(supplemental.every(connection => connection.kind === 'door' && connection.a !== OUTSIDE && connection.b !== OUTSIDE));
    const firstWindow = result.design.connections.findIndex(connection => connection.kind === 'window');
    if (firstWindow >= 0) assert.ok(result.design.connections.slice(0, firstWindow).some(connection => supplemental.some(added => added.id === connection.id)),
      'a needed door precedes competing window guidance');
    const traversable = result.openings.filter(opening => opening.kind === 'door' || opening.kind === 'open');
    const adjacency = new Map(design.spaces.map(space => [space.id, []]));
    for (const opening of traversable) if (opening.a !== OUTSIDE && opening.b !== OUTSIDE) {
      adjacency.get(opening.a).push(opening.b);
      adjacency.get(opening.b).push(opening.a);
    }
    const seen = new Set([design.spaces[0].id]), queue = [design.spaces[0].id];
    for (const id of queue) for (const next of adjacency.get(id)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    assert.equal(seen.size, design.spaces.length, 'windows do not provide traversable connectivity');
    const { mask, blockers } = checkRealization(result, footprint);
    checkInteriorAccess(result, mask, blockers);
  }
});

test('soft connection and exterior preferences do not reject feasible ownership', () => {
  const footprint = cellsOf(8, 6);
  const design = { spaces: [room('a', 9, 40, 'avoid'), room('b', 9, 40, 'avoid')], connections: [
    { id: 'south-a', a: 'a', b: OUTSIDE, kind: 'window', side: 'S' },
    { id: 'south-b', a: 'b', b: OUTSIDE, kind: 'window', side: 'S' },
  ] };
  const result = checkAllocation(allocateBuilding(design, footprint, { seed: 5 }), design, footprint);
  checkRealization(result, footprint);
});

test('invalid input and an exhausted search return bounded failures', () => {
  const footprint = cellsOf(9, 6), design = designOf(['a', 'b']);
  for (const [badDesign, badFootprint, options] of [
    [design, [], {}],
    [design, [...footprint, footprint[0]], {}],
    [design, cellsOf(25, 3), {}],
    [designOf(Array.from({ length: 9 }, (_, i) => `r${i}`)), footprint, {}],
    [design, footprint, { maxSteps: 0 }],
    [design, footprint, { maxSolutions: 0 }],
    [{ spaces: [room('a', 50, 50), room('b', 50, 50)], connections: [] }, footprint, {}],
  ]) {
    const result = allocateBuilding(badDesign, badFootprint, options);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length);
    assert.equal(result.search.optimal, false);
  }
  const exhausted = allocateBuilding(designOf(['a', 'b', 'c']), footprint, { maxSteps: 1, maxSolutions: 1 });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.search.budgetExhausted, true);
  assert.ok(exhausted.search.steps <= 1);
});

test('minimum rooms, thin tails, narrow joins and supplemental id collisions', () => {
  const single = allocateBuilding({ spaces: [room('only', 9, 9)], connections: [] }, cellsOf(3, 3));
  assert.equal(single.ok, true, single.reason);
  assert.deepEqual(single.openings, []);
  assert.deepEqual(single.search, { steps: 1, solutions: 1, budgetExhausted: false, optimal: false });
  const tail = [...cellsOf(3, 3), { x: 3, y: 1 }];
  const thin = allocateBuilding({ spaces: [room('only')], connections: [] }, tail);
  assert.equal(thin.ok, false, 'area alone cannot make a thin appendage usable');
  assert.equal(thin.search.budgetExhausted, false);
  // Two usable squares with only a one-cell seam cannot be joined by a doorway.
  const pinched = [...cellsOf(3, 3), ...cellsOf(3, 3).map(c => ({ x: c.x + 3, y: c.y + 2 }))];
  const disconnected = allocateBuilding(designOf(), pinched);
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.search.budgetExhausted, false);
  const design = { spaces: [room('@remaining'), room('b')], connections: [
    { id: 'allocation-door-0', a: '@remaining', b: 'b', kind: 'window' },
  ] };
  const result = allocateBuilding(design, cellsOf(6, 3));
  assert.equal(result.ok, true, result.reason);
  assert.equal(new Set(result.design.connections.map(c => c.id)).size, result.design.connections.length);
  assert.equal(result.openings[0].kind, 'door');
  assert.ok(!result.openings.some(o => o.connectionId === 'allocation-door-0'), 'window remains soft when a doorway occupies its run');
});

test('search limits retain feasible results, named preferences score them, and seeds vary ties', () => {
  const footprint = cellsOf(9, 6), design = { spaces: [room('a', 9, 100, 'prefer'), room('b', 9, 100, 'prefer')], connections: [
    { id: 'join', a: 'a', b: 'b', kind: 'open' },
  ] };
  const variants = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const result = allocateBuilding(design, footprint, { seed, maxSolutions: 1 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.search.solutions, 1);
    assert.equal(result.search.budgetExhausted, true);
    assert.deepEqual(result.scoreComponents, { connections: 1, outside: 2 });
    assert.equal(result.design.connections.length, 1, 'authored traversable guidance supplies the tree');
    variants.add(JSON.stringify(result.allocation));
  }
  assert.ok(variants.size > 1, 'seed influences equally balanced cuts');
  const large = allocateBuilding(designOf(Array.from({ length: 8 }, (_, i) => `room-${i}`)), cellsOf(24, 24), { maxSolutions: 1 });
  assert.equal(large.ok, true, large.reason);
  checkAllocation(large, designOf(Array.from({ length: 8 }, (_, i) => `room-${i}`)), cellsOf(24, 24));
  const { mask, blockers } = checkRealization(large, large.allocation.footprint);
  checkInteriorAccess(large, mask, blockers);
});

test('branching cuts fit six exact rooms around an exact corridor with six usable doors', () => {
  const footprint = cellsOf(12, 11);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const design = { spaces: [room('corridor', 36, 36), ...ids.map(id => room(id, 16, 16))],
    connections: ids.map(id => ({ id: `corridor-${id}`, a: 'corridor', b: id, kind: 'door' })) };
  // A witness is three 4x4 rooms, a 12x3 corridor, then three more 4x4 rooms.
  const result = checkAllocation(allocateBuilding(design, footprint, { seed: 0, maxSteps: 20000 }),
    design, footprint, 20000);
  assert.equal(result.scoreComponents.connections, 6, 'all six requested corridor doors are placed');
  for (const connection of design.connections)
    assert.ok(result.openings.some(opening => opening.connectionId === connection.id && opening.kind === 'door'),
      `${connection.id} has a door`);
  const { mask, blockers } = checkRealization(result, footprint);
  checkInteriorAccess(result, mask, blockers);
  const radius = microMetrics({ cellSize: 40, bodyProfile: 'cell' }).clearance.hunter;
  const centerOf = id => {
    const center = patchCenters(spaceCells(result, id))[0];
    return { x: (center.x + 0.5) * 40, y: (center.y + 0.5) * 40 };
  };
  for (const id of ids)
    assert.ok(findRegionRoute(mask, blockers, centerOf('corridor'), centerOf(id), radius),
      `hunter crosses corridor-${id}`);
});

test('a four-room cycle can select four quadrants instead of only parallel slabs', () => {
  const footprint = cellsOf(12, 12);
  const design = { spaces: ['a', 'b', 'c', 'd'].map(id => room(id, 36, 36)), connections: [
    { id: 'ab', a: 'a', b: 'b', kind: 'door' },
    { id: 'bd', a: 'b', b: 'd', kind: 'door' },
    { id: 'dc', a: 'd', b: 'c', kind: 'door' },
    { id: 'ca', a: 'c', b: 'a', kind: 'door' },
  ] };
  const quadrantBoxes = new Set([
    JSON.stringify({ x0: 0, x1: 5, y0: 0, y1: 5 }),
    JSON.stringify({ x0: 6, x1: 11, y0: 0, y1: 5 }),
    JSON.stringify({ x0: 0, x1: 5, y0: 6, y1: 11 }),
    JSON.stringify({ x0: 6, x1: 11, y0: 6, y1: 11 }),
  ]);
  let quadrant;
  for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const result = allocateBuilding(design, footprint, { seed, maxSteps: 20000, maxSolutions: 128 });
    assert.equal(result.ok, true, `seed ${seed}: ${result.reason}`);
    if (result.scoreComponents.connections === 4
      && result.allocation.spaces.every(space => quadrantBoxes.has(JSON.stringify(boundsOf(space.cells))))) {
      quadrant = checkAllocation(result, design, footprint, 20000, 128);
      break;
    }
  }
  assert.ok(quadrant, 'at least one seed finds the 2x2 layout and realizes all four cycle doors');
  const { mask, blockers } = checkRealization(quadrant, footprint);
  checkInteriorAccess(quadrant, mask, blockers);
});

test('hub guidance scores authored doors against a realizable five-neighbor witness', () => {
  const footprint = cellsOf(16, 10);
  const leaves = ['a', 'b', 'c', 'd', 'e'];
  const design = { spaces: [room('h', 12, 40), ...leaves.map(id => room(id, 12, 40))],
    connections: leaves.map(id => ({ id: `h-${id}`, a: 'h', b: id, kind: 'door' })) };
  // A central 4x10 hub can meet three 6-wide rooms to its left and two to its right.
  // The score is a soft measure of requested openings, not a claim of optimal search.
  let best = 0;
  for (const seed of [0, 1, 2, 3]) {
    const result = checkAllocation(allocateBuilding(design, footprint, { seed }), design, footprint);
    const fulfilled = design.connections.filter(connection => result.openings.some(opening =>
      opening.connectionId === connection.id && opening.kind === 'door')).length;
    assert.equal(result.scoreComponents.connections, fulfilled, `seed ${seed} scores placed authored doors`);
    assert.ok(fulfilled >= 4, `seed ${seed} preserves at least four hub requests at the default budget`);
    best = Math.max(best, fulfilled);
    const { mask, blockers } = checkRealization(result, footprint);
    checkInteriorAccess(result, mask, blockers);
  }
  assert.ok(best >= 4, `at least four of five hub requests should be achievable; best was ${best}`);
});

test('allocation openings describe default overlap placement before optional corner trims', () => {
  const footprint = cellsOf(6, 6, (x, y) => x < 3 || y >= 3);
  const design = { spaces: [room('a', 27, 27)], connections: [
    { id: 'entry', a: 'a', b: OUTSIDE, kind: 'door', side: 'E' },
  ] };
  const result = checkAllocation(allocateBuilding(design, footprint), design, footprint);
  const before = structuredClone(result);
  const overlap = realizeBuilding(result.design, result.allocation, { cellSize: 40, encloses: false });
  const trimmed = realizeBuilding(result.design, result.allocation,
    { cellSize: 40, encloses: false, corners: 'horizontal' });
  assert.deepEqual(overlap.issues, []);
  assert.deepEqual(trimmed.issues, []);
  assert.deepEqual(overlap.openings, result.openings, 'allocation reports the default untrimmed placement');
  assert.equal(result.openings[0].run.axis, 'v');
  assert.equal(result.openings[0].center, 1.5);
  assert.equal(trimmed.openings[0].center, 1.625, 'one trimmed run end shifts its actual door');
  assert.deepEqual(result, before, 'alternate realization does not mutate allocation results');
});
