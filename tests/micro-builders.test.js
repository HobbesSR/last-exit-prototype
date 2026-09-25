import test from 'node:test';
import assert from 'node:assert/strict';
import { outline, transform } from '../shared/shape.ts';
import { generateMicroRegion, validateMicroRegion } from '../shared/map/micro/index.ts';

const CELLS_W = 24, CELLS_H = 18, CELL = 40;
const cells = (predicate = () => true) => Array.from({ length: CELLS_H }, (_, y) =>
  Array.from({ length: CELLS_W }, (_, x) => ({ x, y })).filter(cell => predicate(cell.x, cell.y))).flat();
const full = cells();
const lShape = cells((x, y) => (x <= 7 || (y >= 7 && y <= 10)));
const hole = cells((x, y) => !(x >= 10 && x <= 13 && y >= 6 && y <= 11));
const ports = () => [
  { id: 'west', side: 'W', start: { x: 0, y: 8 }, length: 2, required: 'hunter', allowed: 'hunter' },
  { id: 'east', side: 'E', start: { x: 23, y: 8 }, length: 2, required: 'hunter', allowed: 'hunter' },
];
const spec = (builder, seed, owned = full, extra = {}) => ({
  id: `test-${builder}`, seed, builder, cellSize: CELL, cells: owned, ports: ports(),
  loot: { budget: 5, tier: 2 }, ...extra,
});
const generatedShapes = result => result.elements.flatMap(element => element.template.parts
  .filter(part => part.part === 'obstacle')
  .map(part => transform(part.shape, element.x, element.y)));
const verify = result => assert.deepEqual(validateMicroRegion(result), [], `${result.spec.id}/${result.spec.builder}: ${validateMicroRegion(result).join('; ')}`);

test('micro builders are deterministic, preserve their input, and vary by seed', () => {
  for (const builder of ['open', 'depot', 'courtyard', 'ruins']) {
    const input = spec(builder, 701), original = structuredClone(input);
    const first = generateMicroRegion(input), second = generateMicroRegion(input);
    assert.deepEqual(first, second, `${builder} changed for the same seed`);
    assert.deepEqual(input, original, `${builder} mutated its spec`);
    assert.notDeepEqual(first.elements, generateMicroRegion(spec(builder, 702)).elements, `${builder} ignores its seed`);
    verify(first);
  }
});

test('default depot and courtyard produce actual roofed structures and fill the requested loot budget', () => {
  for (const builder of ['depot', 'courtyard']) {
    const result = generateMicroRegion(spec(builder, 88));
    assert.ok(result.manifest.structures > 0, `${builder} silently produced no enclosing structures`);
    assert.ok(result.elements.some(element => element.template.encloses), `${builder} emitted no roofed room`);
    assert.equal(result.loot.length, result.spec.loot.budget, `${builder} did not fulfill its usable loot budget`);
    assert.equal(new Set(result.loot.map(point => `${Math.floor(point.x / CELL)},${Math.floor(point.y / CELL)}`)).size, result.loot.length,
      `${builder} placed more than one loot spawn in a cell`);
    verify(result);
  }
});

test('ruins retain off-grid convex polygon debris, rather than reducing all generated cover to cells', () => {
  const result = generateMicroRegion(spec('ruins', 93, full, { parameters: { decay: 1 } }));
  const polygons = generatedShapes(result).filter(shape => shape.kind === 'polygon');
  assert.ok(polygons.length > 0, 'fully decayed ruins emitted no convex debris');
  assert.ok(polygons.some(shape => outline(shape).some(point => point.x % CELL !== 0 || point.y % CELL !== 0)),
    'ruin debris was snapped back to the cell grid');
  verify(result);
});

test('ruin decay changes emitted geometry from intact spans to collapsed rubble', () => {
  const intact = generateMicroRegion(spec('ruins', 93, full, { parameters: { density: .55, decay: 0 } }));
  const collapsed = generateMicroRegion(spec('ruins', 93, full, { parameters: { density: .55, decay: 1 } }));
  const obstacleKinds = result => generatedShapes(result).map(shape => shape.kind);
  assert.notDeepEqual(collapsed.elements, intact.elements, 'decay must change emitted ruin geometry');
  assert.equal(obstacleKinds(intact).filter(kind => kind === 'polygon').length, 0, 'intact ruins should retain spans');
  assert.ok(obstacleKinds(collapsed).filter(kind => kind === 'polygon').length > 0, 'collapsed ruins should show rubble');
  verify(intact); verify(collapsed);
});

test('density changes the generated content and each irregular mask remains valid across seeded batches', () => {
  const sparse = generateMicroRegion(spec('depot', 120, full, { parameters: { density: .1 } }));
  const dense = generateMicroRegion(spec('depot', 120, full, { parameters: { density: .9 } }));
  assert.notDeepEqual(sparse.elements, dense.elements, 'density does not affect depot content');

  for (const builder of ['open', 'depot', 'courtyard', 'ruins']) {
    for (const owned of [full, lShape, hole]) {
      for (let seed = 1; seed <= 8; seed++) verify(generateMicroRegion(spec(builder, seed, owned)));
    }
  }
});

test('invalid parameter bounds are rejected before generation', () => {
  for (const parameters of [
    { density: -0.01 }, { density: 1.01 }, { roomCells: 3 }, { roomCells: 13 }, { decay: -0.01 }, { decay: 1.01 },
  ]) assert.throws(() => generateMicroRegion(spec('open', 3, full, { parameters })), /parameter|density|roomCells|decay/i);
});

test('every valid tuning extreme keeps shelves and generated geometry valid', () => {
  for (const builder of ['open', 'depot', 'courtyard', 'ruins']) {
    for (const parameters of [
      { density: 0, roomCells: 4, decay: 0 },
      { density: 1, roomCells: 12, decay: 1 },
    ]) {
      const result = generateMicroRegion(spec(builder, 211, full, { parameters }));
      if (builder !== 'ruins') assert.ok(result.manifest.structures > 0, `${builder} accepted no roofed placement at a valid tuning endpoint`);
      verify(result);
    }
  }
});
