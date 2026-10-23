import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { PLACEABLES, buildPlaceable } from '../map/micro/placeables/index.ts';
import { demandShapes, placeableErrors, placedElements } from '../map/micro/placeables/placeable.ts';
import { HOUSE } from '../map/micro/placeables/house.ts';
import { WAREHOUSE } from '../map/micro/placeables/warehouse.ts';
import { createAddressedArea } from '../map/micro/addressed.ts';
import { createRegionMask } from '../map/micro/geometry.ts';
import { bounds } from '../shared/shape.ts';

const SIZE = 40, EPS = 1e-6;
const FOLDER = new URL('../map/micro/placeables/', import.meta.url);
/** Modules in the folder that hold machinery, not a placeable. */
const MACHINERY = new Set(['index.ts', 'placeable.ts', 'frame.ts']);

/**
 * Each placeable's version and a digest of what its examples build. A digest that moves
 * without its version means `build` changed output silently: bump the placeable's version
 * and `REGION_TYPES_VERSION`, then update both here (20.8).
 */
const PINNED = {
  warehouse: ['warehouse-2', '909410dc06fd461f'],
  'container-row': ['container-row-1', '9840d185b0ad635e'],
  house: ['house-1', 'c41930e3e9dfa4d7'],
  'cover-piece': ['cover-piece-1', '86aac37c1290a2fa'],
  'wall-run': ['wall-run-1', 'b561356f4a5ad4c6'],
  'compound-ring': ['compound-ring-1', '095003e5438bad82'],
  'checkpoint-barrier': ['checkpoint-barrier-1', 'de6b024a4cea7410'],
  'example-room-shell': ['example-room-shell-1', '27464143c2deb445'],
  'fallen-slab': ['fallen-slab-1', '714ae94d6dcc1fbb'],
  'hall-pillar': ['hall-pillar-1', 'f16b2fc1db46654b'],
  'ruin-room-span': ['ruin-room-span-1', '05cc9a34bef0eb9a'],
  'rubble-debris': ['rubble-debris-1', '209ff412b34fdc6a'],
  'park-tree': ['park-tree-1', '92d74038005d8c5a'],
  'park-hedge-run': ['park-hedge-run-1', '53e26ff94e80e196'],
  'plant-machine': ['plant-machine-1', '8975ce930b7a04e3'],
  'plant-pipe-run': ['plant-pipe-run-1', '3c4eed0ac5a59880'],
};

const digest = placeable => createHash('sha256').update(JSON.stringify(placeable.examples.map(params => {
  const result = placeable.build(params, SIZE);
  return 'refused' in result ? result : { elements: result.elements, demand: result.demand };
}))).digest('hex').slice(0, 16);

test('the registry lists every placeable module in the folder, each under its own id with a header', async () => {
  const files = readdirSync(FOLDER).filter(name => name.endsWith('.ts') && !MACHINERY.has(name)).sort();
  const found = [];
  for (const file of files) {
    const exports = Object.values(await import(new URL(file, FOLDER).href)).filter(value => value && typeof value.build === 'function' && typeof value.id === 'string');
    assert.equal(exports.length, 1, `${file} exports one placeable`);
    const [placeable] = exports;
    assert.equal(PLACEABLES[placeable.id], placeable, `${placeable.id} is registered`);
    assert.match(readFileSync(new URL(file, FOLDER), 'utf8'), new RegExp(`/\\*\\r?\\n \\* \`${placeable.id}\`: `), `${file} opens with a header naming ${placeable.id}`);
    found.push(placeable.id);
  }
  assert.deepEqual(found.sort(), Object.keys(PLACEABLES).sort());
  for (const [id, placeable] of Object.entries(PLACEABLES)) assert.equal(placeable.id, id);
});

test('each placeable pins its version to what its examples build', () => {
  assert.deepEqual(Object.keys(PINNED).sort(), Object.keys(PLACEABLES).sort());
  for (const [id, placeable] of Object.entries(PLACEABLES)) {
    const [version, pinned] = PINNED[id];
    assert.equal(placeable.version, version, `${id} version`);
    assert.equal(digest(placeable), pinned, `${id} built differently at ${version}: bump its version and REGION_TYPES_VERSION`);
  }
});

test('every example is valid and builds inside its demanded body', () => {
  for (const placeable of Object.values(PLACEABLES)) for (const params of placeable.examples) {
    const name = `${placeable.id} ${JSON.stringify(params)}`;
    assert.deepEqual(placeableErrors(placeable, params), [], name);
    const result = placeable.build(params, SIZE);
    assert.ok(!('refused' in result), `${name} builds`);
    const { w, h } = result.demand.body, inside = (x, y) => x >= -EPS && y >= -EPS && x <= w * SIZE + EPS && y <= h * SIZE + EPS;
    for (const element of result.elements) for (const part of element.template.parts) {
      const box = part.part === 'obstacle' ? bounds(part.shape) : { x: part.x, y: part.y, w: part.part === 'spot' ? 0 : part.w, h: part.part === 'spot' ? 0 : part.h };
      const x = element.x + box.x, y = element.y + box.y;
      if (part.part === 'gate') assert.ok(inside(x, y), `${name}: a gate's centre is in the body`);
      else assert.ok(inside(x, y) && inside(x + box.w, y + box.h), `${name}: a ${part.part} is in the body`);
    }
    // Placed anywhere, the demand's shapes are disjoint: an addressed area takes every one.
    const cells = [];
    for (let y = -3; y < h + 3; y++) for (let x = -3; x < w + 3; x++) cells.push({ x: x + 5, y: y + 5 });
    const area = createAddressedArea(createRegionMask({ cells, cellSize: SIZE }));
    for (const shape of demandShapes(result.demand, 5, 5, SIZE)) assert.ok(area.mark(shape), `${name}: demand shapes are disjoint`);
  }
});

test('placed elements sit at their cell and keep the builder label', () => {
  const placed = PLACEABLES['cover-piece'].build({ piece: 'barrier', turned: false, length: 0.5, offset: 0.5 }, SIZE);
  const [element] = placedElements(placed, 'cover-barrier-1', 3, 2, SIZE);
  assert.deepEqual(Object.keys(element), ['label', 'x', 'y', 'template']);
  assert.equal(element.label, 'cover-barrier-1');
  assert.deepEqual([element.x, element.y], [120, 80]);
  assert.equal(placedElements({ ...placed, elements: [{ ...placed.elements[0], name: 'east' }] }, 'room', 0, 0, SIZE)[0].label, 'room-east');
});

test('a house demands the doorstep outside its door', () => {
  for (const door of ['N', 'E', 'S', 'W']) {
    const result = HOUSE.build({ w: 4, h: 4, door, spaces: 1, seed: 0 }, SIZE);
    assert.equal(result.demand.clear.length, 1);
    const step = result.demand.clear[0];
    const outside = { N: step.y + step.h === 0, S: step.y === 4, W: step.x + step.w === 0, E: step.x === 4 };
    assert.ok(outside[door], `${door} doorstep is outside that side`);
    assert.equal(Math.min(step.w, step.h), 2, 'a hunter deep');
  }
});

test('a house that cannot fit its spaces is refused, not thrown', () => {
  const result = HOUSE.build({ w: 3, h: 6, door: 'N', spaces: 3, seed: 1 }, SIZE);
  assert.ok('refused' in result);
  assert.match(result.refused, /3-space house/);
});

test('warehouse door demands cover both whole-cell stands and merge adjacent doorsteps', () => {
  for (const params of WAREHOUSE.examples) {
    const { demand, details } = WAREHOUSE.build(params, SIZE);
    for (const door of details.realization.openings.filter(o => o.kind === 'door' && (o.a === 'outside' || o.b === 'outside'))) {
      const { run } = door, horizontal = run.axis === 'h';
      const start = (horizontal ? run.x : run.y) + door.center - 1;
      for (const along of new Set([Math.floor(start), Math.ceil(start)])) {
        const step = horizontal ? { x: along, y: run.y === 0 ? -2 : params.h }
          : { x: run.x === 0 ? -2 : params.w, y: along };
        assert.ok(demand.clear.some(b => b.x <= step.x && b.y <= step.y && b.x + b.w >= step.x + 2 && b.y + b.h >= step.y + 2),
          `${door.connectionId} has its complete two-cell stand`);
      }
    }
  }
  const merged = WAREHOUSE.build({ w: 6, h: 8, alongX: false, seed: 2 }, SIZE);
  assert.deepEqual(merged.demand.clear, [{ x: 0, y: -2, w: 3, h: 2 }, { x: 0, y: 8, w: 6, h: 2 }]);
  const separated = WAREHOUSE.build({ w: 10, h: 8, alongX: true, seed: 7 }, SIZE);
  assert.equal(separated.demand.clear.filter(b => b.x === 10).length, 2, 'separated doors retain their gap');
});

test('parameters are checked against their specs, then the placeable\'s own rules', () => {
  const house = PLACEABLES.house;
  assert.deepEqual(placeableErrors(house, null), ['house needs a parameter object.']);
  assert.deepEqual(placeableErrors(house, { w: 4, h: 4, door: 'S', spaces: 1, seed: 0, roof: true }), ['house has no parameter roof.']);
  assert.deepEqual(placeableErrors(house, { w: 4, h: 4, door: 'S', spaces: 1 }), ['house seed is missing.']);
  assert.deepEqual(placeableErrors(house, { w: 2.5, h: 4, door: 'up', spaces: 1, seed: 0 }),
    ['house w must be a whole number from 3 to 12.', 'house door must be one of N, E, S, W.']);
  assert.deepEqual(placeableErrors(house, { w: 3, h: 4, door: 'S', spaces: 2, seed: 0 }), ['A house of 2 spaces needs at least 18 cells.']);
  assert.deepEqual(placeableErrors(PLACEABLES['container-row'], { length: 5, alongX: true }), ['container-row length must be a multiple of 2.']);
  assert.deepEqual(placeableErrors(PLACEABLES['cover-piece'], { piece: 'crate', turned: 'no', length: 2, offset: 0 }),
    ['cover-piece turned must be true or false.', 'cover-piece length must be a number from 0 to 1.']);
});

test('building by id checks what it is given', () => {
  assert.throws(() => buildPlaceable('fountain', {}, SIZE), /Unknown placeable fountain/);
  assert.throws(() => buildPlaceable('toString', {}, SIZE), /Unknown placeable/);
  assert.throws(() => buildPlaceable('container-row', { length: 3, alongX: true }, SIZE), RangeError);
  const built = buildPlaceable('container-row', { length: 4, alongX: false }, SIZE);
  assert.deepEqual(built.demand.body, { w: 1, h: 4 });
  assert.equal(built.elements[0].template.parts.length, 2);
});
