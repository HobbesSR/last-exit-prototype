import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { composeRegions } from '../map/micro/compose.ts';
import { builtMapCollision } from '../map/micro/adapter.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { LIMITS } from '../map/micro/limits.ts';

/**
 * A synthetic macro-sized map (51 stage 7, 17 M7): a 100 × 70 band of open ground across
 * the top, past the old 4,096-cell and 64-per-axis limits, over 20 × 15 blocks of 5 × 5
 * cells. Every neighbouring pair shares one portal of two segments, named alike on both
 * sides as macro names them (51 stage 5).
 */
const SIZE = 48, BAND = 70, BLOCK = 5, COLS = 20, ROWS = 15;
function syntheticBriefs() {
  const regions = new Map(), owner = new Map();
  const region = (id, cells) => {
    regions.set(id, { id, seed: regions.size + 1, type: 'example-open', cellSize: SIZE, cells, zones: [{ tier: 1, bonus: 0, lootChance: 0.04, cells }], portals: [] });
    for (const c of cells) owner.set(`${c.x},${c.y}`, id);
  };
  const band = [];
  for (let y = 0; y < BAND; y++) for (let x = 0; x < COLS * BLOCK; x++) band.push({ x, y });
  region('band', band);
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    const cells = [];
    for (let y = 0; y < BLOCK; y++) for (let x = 0; x < BLOCK; x++) cells.push({ x: col * BLOCK + x, y: BAND + row * BLOCK + y });
    region(`block-${String(row).padStart(2, '0')}-${String(col).padStart(2, '0')}`, cells);
  }
  const share = (axis, x, y) => {
    // The portal's first segment: the cells before and after the line, by the kernel's run convention.
    const [before, after] = axis === 'h' ? [`${x},${y - 1}`, `${x},${y}`] : [`${x - 1},${y}`, `${x},${y}`];
    const a = owner.get(before), b = owner.get(after), portal = { id: `${a}~${b}~${axis}:${x},${y}`, axis, x, y, length: 2 };
    regions.get(a).portals.push(portal);
    regions.get(b).portals.push({ ...portal });
  };
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
    const x = col * BLOCK, y = BAND + row * BLOCK;
    share('h', x + 1, y);
    if (col) share('v', x, y + 1);
  }
  return [...regions.values()];
}
const results = syntheticBriefs().map(brief => buildRegion(brief));
const reorder = list => [...list.filter((_, i) => i % 2), ...list.filter((_, i) => !(i % 2))].reverse();
const withBrief = (list, id, change) => list.map(r => r.brief.id === id ? { ...r, brief: change(structuredClone(r.brief)) } : r);

test('a macro-sized map composes the same whatever order its results come in', () => {
  const map = composeRegions(results);
  assert.equal(map.regions.length, 1 + COLS * ROWS);
  assert.ok(map.regions.find(r => r.brief.id === 'band').brief.cells.length > 4096);
  assert.equal(map.pairs.length, COLS * ROWS + (COLS - 1) * ROWS);
  assert.deepEqual(map.regions.map(r => r.brief.id), results.map(r => r.brief.id).sort());
  assert.deepEqual(composeRegions(reorder(results)), map);
  assert.deepEqual(composeRegions([...results].reverse()), map);
  assert.deepEqual(map.pairs.find(p => p.a === 'band' || p.b === 'band'), { portal: 'band~block-00-00~h:1,70', a: 'band', b: 'block-00-00' });
});

test('a disagreeing pair is refused, not repaired', () => {
  const id = 'band~block-00-00~h:1,70';
  const moved = withBrief(results, 'block-00-00', b => (b.portals.find(p => p.id === id).x = 2, b));
  assert.throws(() => composeRegions(moved), /Portal band~block-00-00~h:1,70 of region band has no matching portal in region block-00-00/);
  const longer = withBrief(results, 'band', b => (b.portals.find(p => p.id === id).length = 3, b));
  assert.throws(() => composeRegions(longer), /of region band has no matching portal in region block-00-00/);
  const dropped = withBrief(results, 'block-00-00', b => (b.portals = b.portals.filter(p => p.id !== id), b));
  assert.throws(() => composeRegions(dropped), /of region band has no matching portal in region block-00-00/);
  // Both sides of one pair renamed to another pair's id agree with each other, but the id no longer names one pair.
  const other = 'block-00-00~block-00-01~v:5,71', renamed = ['block-01-00', 'block-01-01'].reduce((list, region) =>
    withBrief(list, region, b => (b.portals.find(p => p.id === 'block-01-00~block-01-01~v:5,76').id = other, b)), results);
  assert.throws(() => composeRegions(renamed), /Portal block-00-00~block-00-01~v:5,71 names two pairs: regions block-00-00 and block-00-01, and regions block-01-00 and block-01-01/);
  const straddling = withBrief(results, 'band', b => (b.portals.find(p => p.id === id).length = 6, b));
  assert.throws(() => composeRegions(straddling), /straddles regions block-00-00 and block-00-01/);
});

test('ownership, identity and scale are refused when they disagree', () => {
  const block = results.find(r => r.brief.id === 'block-00-00');
  assert.throws(() => composeRegions([...results, { ...block, brief: { ...block.brief, id: 'zz', portals: [] } }]), /Regions block-00-00 and zz both own cell 0,70/);
  assert.throws(() => composeRegions([...results, block]), /block-00-00 appears twice/);
  assert.throws(() => composeRegions(withBrief(results, 'block-00-00', b => (b.cellSize = 40, b))), /cell size 40/);
  assert.throws(() => composeRegions(results.filter(r => r.brief.id !== 'block-00-00')), /of region band faces cells no region owns/);
  assert.throws(() => composeRegions(withBrief(results, 'band', b => (b.portals.push({ ...b.portals[0] }), b))), /names a portal twice/);
  assert.throws(() => composeRegions(withBrief(results, 'band', b => (b.portals.push({ id: 'inner', axis: 'h', x: 4, y: 10, length: 2 }), b))), /inner of region band isn't on its perimeter/);
});

test('the bounds are explicit tool limits, raised for macro-sized regions', () => {
  assert.throws(() => composeRegions([]), /1 to 4096 region results/);
  const one = results[1];
  assert.throws(() => composeRegions(Array.from({ length: LIMITS.mapRegions + 1 }, () => one)), /1 to 4096 region results/);
  const line = n => Array.from({ length: n }, (_, x) => ({ x, y: 0 }));
  const brief = cells => ({ id: 'wide', seed: 1, type: 'example-open', cellSize: SIZE, cells, zones: [{ tier: 1, bonus: 0, lootChance: 0, cells }], portals: [] });
  assert.throws(() => buildRegion(brief(line(LIMITS.regionSpan + 1))), /at most 512 cells per axis/);
  const square = [];
  for (let y = 0; y < 257; y++) for (let x = 0; x < 256; x++) square.push({ x, y });
  assert.throws(() => buildRegion(brief(square)), /1 to 65536 cells/);
});

test('a composed map stamps its geometry through the adapter, sized to its cells', () => {
  const map = composeRegions(results), collision = builtMapCollision(map);
  assert.equal(collision.width, COLS * BLOCK * SIZE);
  assert.equal(collision.height, (BAND + ROWS * BLOCK) * SIZE);
  const shapes = map.regions.flatMap(r => r.elements.flatMap(e => elementShapes(e)));
  assert.ok(shapes.length > 0);
  assert.equal(collision.obstacles.length, shapes.length);
  assert.deepEqual(builtMapCollision(composeRegions(reorder(results))), collision);
});
