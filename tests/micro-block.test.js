import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { planBlock } from '../map/micro/strategies/block.ts';
import { boundaryRuns } from '../map/kernel/run.ts';
import { createRegionMask, elementShapes, findRegionRoute, shapesOverlap } from '../map/micro/geometry.ts';
import { hunterClearance, portalStands, validatePortalReach } from '../map/micro/portals.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle } from '../shared/shape.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals) => ({ id, seed, type: 'block', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.3, cells }], portals });

/** A wide field, an L, a ring around a hole and a deep block, with portals on several sides. */
const MASKS = {
  field: [cellsOf(44, 34), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 44, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(56, 56, (x, y) => y < 26 || x < 26), [{ id: 'east', axis: 'v', x: 56, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 56, length: 4 },
    { id: 'corner', axis: 'h', x: 30, y: 26, length: 6 }]],
  ring: [cellsOf(64, 64, (x, y) => x < 24 || x >= 40 || y < 24 || y >= 40), [{ id: 'north', axis: 'h', x: 20, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 40, y: 28, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 50, length: 3 }]],
  deep: [cellsOf(72, 60), [{ id: 'west', axis: 'v', x: 0, y: 30, length: 2 }, { id: 'east', axis: 'v', x: 72, y: 2, length: 2 },
    { id: 'south', axis: 'h', x: 60, y: 60, length: 2 }, { id: 'north', axis: 'h', x: 4, y: 0, length: 2 }]],
};
const SEEDS = [1, 2, 3, 4];
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const key = c => `${c.x},${c.y}`;
const sameRun = (p, q) => p.axis === q.axis && p.x === q.x && p.y === q.y && p.length === q.length;

test('a block keeps the portal promise over seeds and masks', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const result = buildRegion(brief(name, seed, cells, portals));
    assert.ok(result.manifest.lots >= 2, `${name} seed ${seed} has lots`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
  }
});

test('a block\'s children partition it, and every two that share a boundary have a portal between them', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const { lots, alleys } = planBlock(brief(name, seed, cells, portals)), children = [...lots, alleys];
    const owned = children.flatMap(child => child.cells.map(key));
    assert.equal(new Set(owned).size, owned.length, `${name} ${seed}: no cell has two owners`);
    assert.deepEqual(new Set(owned), new Set(cells.map(key)), `${name} ${seed}: every cell has an owner`);
    // The block's own portals all lie on the alleys.
    for (const portal of portals) assert.ok(alleys.portals.some(p => p.id === portal.id && sameRun(p, portal)), `${name} ${seed}: ${portal.id}`);
    for (const { a, b } of boundaryRuns(children)) {
      assert.ok([a, b].includes(alleys.id), `${name} ${seed}: lots ${a} and ${b} never touch`);
      const lot = children.find(child => child.id === (a === alleys.id ? b : a));
      assert.equal(lot.portals.length, 2);
      for (const frontage of lot.portals)
        assert.ok(alleys.portals.some(p => p.id === frontage.id && sameRun(p, frontage)), `${name} ${seed}: ${lot.id} faces the alleys through portals named alike on both sides`);
    }
    for (const child of children) {
      const zoned = child.zones.flatMap(zone => zone.cells.map(key));
      assert.deepEqual(new Set(zoned), new Set(child.cells.map(key)), `${child.id} is zoned`);
    }
  }
});

test('every lot keeps an alley to the block\'s edge and to every other lot, and suits its type', () => {
  const types = new Set();
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const input = brief(name, seed, cells, portals), mask = createRegionMask(input), { lots } = planBlock(input);
    const boxes = lots.map(lot => {
      const xs = lot.cells.map(c => c.x), ys = lot.cells.map(c => c.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 1, h: Math.max(...ys) - Math.min(...ys) + 1 };
    });
    for (const [k, box] of boxes.entries()) {
      const short = Math.min(box.w, box.h), long = Math.max(box.w, box.h), type = lots[k].type;
      types.add(type);
      assert.equal(lots[k].cells.length, box.w * box.h, 'a lot is a rectangle');
      assert.ok(short >= 6 && long <= 24, `${name} ${seed}: ${box.w} × ${box.h}`);
      if (type === 'hut') assert.ok(long <= 12);
      if (type === 'depot') assert.ok(short >= 10);
      if (type === 'compound') assert.ok(short >= 16);
      for (let y = box.y - 3; y < box.y + box.h + 3; y++) for (let x = box.x - 3; x < box.x + box.w + 3; x++) {
        assert.ok(mask.has(x, y), `${name} ${seed}: lot ${k + 1} keeps 3 owned cells around it`);
        boxes.forEach((other, j) => assert.ok(j === k || !(x >= other.x && x < other.x + other.w && y >= other.y && y < other.y + other.h),
          `${name} ${seed}: lots ${k + 1} and ${j + 1} are an alley apart`));
      }
    }
  }
  assert.deepEqual([...types].sort(), ['compound', 'cover', 'depot', 'hut', 'ruins']);
});

test('every lot keeps its own promise between its frontages, and a hunter reaches it from the block\'s first portal', () => {
  const radius = hunterClearance(SIZE);
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS.slice(0, 1)) {
    const input = brief(name, seed, cells, portals), result = buildRegion(input), mask = createRegionMask(input), shapes = blockers(result);
    const from = portalStands(input, mask)[0].points[0];
    for (const lot of planBlock(input).lots) {
      const own = buildRegion(lot);
      assert.deepEqual(validatePortalReach({ ...lot, blockers: blockers(own) }).errors, [], `${name} ${seed}: ${lot.id} (${lot.type})`);
      // Its own promise joins the frontages, so one stand inside them stands for the lot.
      const point = portalStands(lot)[0].points[0];
      assert.ok(findRegionRoute(mask, shapes, from, point, radius), `${name} ${seed}: ${lot.id} (${lot.type}) at ${point.x},${point.y}`);
    }
  }
});

test('blocks are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.field;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('field', seed, cells, portals));
    assert.deepEqual(buildRegion(brief('field', seed, [...cells].reverse(), portals)).elements, result.elements);
    assert.deepEqual(buildRegion(brief('field', seed, cells, portals)), result);
  }
  const labels = buildRegion(brief('deep', 1, ...MASKS.deep)).elements.map(element => element.label);
  assert.ok(labels.every(label => /^lot-\d+\//.test(label)), 'labels name their lot');
});

test('blocks roll loot by zone and keep every site clear of geometry', () => {
  const [cells, portals] = MASKS.deep;
  const input = brief('deep', 11, cells, portals);
  input.zones = [{ tier: 2, bonus: 0, lootChance: 1, cells: cells.filter(c => c.y < 30) },
    { tier: 5, bonus: 0, lootChance: 0, cells: cells.filter(c => c.y >= 30) }];
  const result = buildRegion(input), mask = createRegionMask(input);
  const shapes = result.elements.flatMap(element => elementShapes(element, true));
  const radius = microMetrics({ cellSize: SIZE, bodyProfile: 'cell' }).lootRadius;
  assert.ok(result.loot.length > 0);
  assert.equal(result.manifest.loot, result.loot.length);
  for (const site of result.loot) {
    assert.ok(site.tier === 2 && site.y < 30 * SIZE);
    const disc = circle(site.x, site.y, radius);
    assert.ok(mask.contains(disc));
    assert.ok(shapes.every(shape => !shapesOverlap(disc, shape)));
  }
});

test('a region with no room for a lot is left open, and a lot\'s name never takes a block portal\'s', () => {
  const thin = buildRegion(brief('thin', 1, cellsOf(60, 11), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 2 }]));
  assert.equal(thin.manifest.lots, undefined);
  assert.equal(thin.elements.length, 0);
  const [cells] = MASKS.field;
  const { lots, alleys } = planBlock(brief('field', 1, cells, [{ id: 'lot-1-N', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'lot-1-W', axis: 'v', x: 44, y: 20, length: 3 }]));
  const ids = alleys.portals.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(lots.every(lot => lot.portals.every(p => !['lot-1-N', 'lot-1-W'].includes(p.id))));
});

test('a macro-sized block with hundreds of portals builds quickly', () => {
  const cells = cellsOf(200, 150), portals = [];
  for (let x = 2; x < 196; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 150, length: 2 });
  for (let y = 2; y < 146; y += 4) portals.push({ id: `w${y}`, axis: 'v', x: 0, y, length: 2 }, { id: `e${y}`, axis: 'v', x: 200, y, length: 2 });
  const started = performance.now();
  const result = buildRegion(brief('macro', 3, cells, portals));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `built in ${Math.round(elapsed)} ms`);
  assert.ok(result.manifest.lots > 50, `${result.manifest.lots} lots`);
});
