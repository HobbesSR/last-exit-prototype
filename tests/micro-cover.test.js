import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { elementShapes } from '../map/micro/geometry.ts';
import { bounds } from '../shared/shape.ts';

const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
const brief = (id, seed, cells, portals, extra = {}) => ({ id, seed, type: 'cover', cellSize: 40, cells,
  zones: [{ tier: 2, bonus: 0, lootChance: 0.2, cells }], portals, ...extra });

/** Masks with portals on several sides: an L, a ring around a hole, and a long field. */
const MASKS = {
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }, { id: 'west', axis: 'v', x: 0, y: 20, length: 2 }]],
  ring: [cellsOf(32, 32, (x, y) => x < 10 || x >= 22 || y < 10 || y >= 22), [{ id: 'north', axis: 'h', x: 12, y: 0, length: 5 },
    { id: 'hole', axis: 'v', x: 22, y: 14, length: 4 }, { id: 'south', axis: 'h', x: 3, y: 32, length: 3 }]],
  field: [cellsOf(60, 18), [{ id: 'west', axis: 'v', x: 0, y: 1, length: 16 }, { id: 'east', axis: 'v', x: 60, y: 7, length: 2 },
    { id: 'north', axis: 'h', x: 25, y: 0, length: 30 }]],
};

const blockers = result => result.elements.flatMap(element => elementShapes(element));

test('a cover region keeps the portal promise over seeds and masks', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of [1, 2, 3, 4, 5, 6]) {
    const result = buildRegion(brief(name, seed, cells, portals));
    assert.ok(result.elements.length, `${name} ${seed} placed cover`);
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
  }
});

test('cover comes in clusters, each boxed with an aisle wider than a door to the next and to the region edge', () => {
  const gap = (a, b) => Math.hypot(Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w), Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h));
  const join = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of [1, 2, 3]) {
    const result = buildRegion(brief(name, seed, cells, portals, { parameters: { density: 1 } }));
    const owned = new Set(cells.map(c => `${c.x},${c.y}`));
    // Merge pieces closer than a door into boxes until every two boxes are a door apart.
    let boxes = blockers(result).map(bounds), merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length && !merged; j++) if (gap(boxes[i], boxes[j]) < 80) {
        boxes = [...boxes.filter((_, k) => k !== i && k !== j), join(boxes[i], boxes[j])]; merged = true;
      }
    }
    assert.ok(boxes.length < blockers(result).length, `${name} ${seed}: some slots hold clusters`);
    for (const a of boxes) {
      assert.ok(a.w <= 160 && a.h <= 160, `${name} ${seed}: a cluster outgrew its slot`);
      for (let y = Math.floor(a.y / 40) - 2; y <= Math.ceil((a.y + a.h) / 40) + 1; y++) for (let x = Math.floor(a.x / 40) - 2; x <= Math.ceil((a.x + a.w) / 40) + 1; x++)
        assert.ok(owned.has(`${x},${y}`), `${name} ${seed}: a cluster within a door of unowned cell ${x},${y}`);
    }
  }
});

test('density sets how much cover there is, and a small region stays clear', () => {
  const [cells, portals] = MASKS.field;
  const count = density => buildRegion(brief('field', 7, cells, portals, { parameters: { density } })).elements.length;
  assert.equal(count(0), 0);
  assert.ok(count(0.3) < count(0.7) && count(0.7) < count(1), `${count(0.3)}, ${count(0.7)}, ${count(1)}`);
  const small = buildRegion(brief('small', 1, cellsOf(6, 6), [{ id: 'west', axis: 'v', x: 0, y: 2, length: 2 }], { parameters: { density: 1 } }));
  assert.deepEqual(small.elements, []);
  assert.throws(() => buildRegion(brief('field', 1, cells, portals, { parameters: { density: 2 } })), /density must be a number from 0 to 1/);
});

test('cover is deterministic in its seed', () => {
  const [cells, portals] = MASKS.ell;
  assert.deepEqual(buildRegion(brief('ell', 9, cells, portals)), buildRegion(brief('ell', 9, cells, portals)));
  assert.notDeepEqual(buildRegion(brief('ell', 9, cells, portals)).elements, buildRegion(brief('ell', 10, cells, portals)).elements);
});

test('loot follows each cell\'s chance and tier, on standing room clear of cover', () => {
  const cells = cellsOf(40, 20), left = cells.filter(c => c.x < 20), right = cells.filter(c => c.x >= 20);
  const result = buildRegion({ ...brief('zoned', 3, cells, []), zones: [{ tier: 1, bonus: 0, lootChance: 0, cells: left }, { tier: 4, bonus: 0, lootChance: 1, cells: right }] });
  assert.ok(result.loot.length > 100 && result.loot.every(l => l.x >= 20 * 40 && l.tier === 4), 'loot only in the sure zone, at its tier');
  const disc = l => ({ x: l.x - 27, y: l.y - 27, w: 54, h: 54 });
  const pieces = blockers(result).map(bounds), apart = (a, b) => a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h;
  assert.ok(result.loot.every(l => pieces.every(p => apart(disc(l), p))), 'no loot under cover');
  assert.equal(new Set(result.loot.map(l => `${Math.floor(l.x / 40)},${Math.floor(l.y / 40)}`)).size, result.loot.length, 'one loot per cell');
  assert.equal(result.manifest.loot, result.loot.length);
  assert.equal(result.manifest.obstacles, result.elements.length);
});

test('core elements asked of a cover region are left for the report to name', () => {
  const [cells, portals] = MASKS.ring;
  const result = buildRegion(brief('ring', 1, cells, portals, { coreElements: { spawn: 4, charger: 1 } }));
  assert.deepEqual(result.coreElements, []);
  assert.equal(result.manifest.coreElements, 0);
});

test('cover builds a macro-sized region with hundreds of portals in bounded time', () => {
  // About the fixture's game-size open ground (#96): 29,500 cells, some 440 portals. Portals
  // ring the field and the 2 × 2 holes in it, as they ring the set pieces in macro's open ground.
  const hole = (x, y) => x % 18 >= 9 && x % 18 < 11 && y % 18 >= 9 && y % 18 < 11;
  const cells = cellsOf(250, 120, (x, y) => !hole(x, y)), portals = [];
  for (let x = 0; x + 2 <= 250; x += 4) portals.push({ id: `n${x}`, axis: 'h', x, y: 0, length: 2 }, { id: `s${x}`, axis: 'h', x, y: 120, length: 2 });
  for (let y = 9; y < 120; y += 18) for (let x = 9; x < 250; x += 18) {
    portals.push({ id: `n${x},${y}`, axis: 'h', x, y, length: 2 }, { id: `s${x},${y}`, axis: 'h', x, y: y + 2, length: 2 },
      { id: `w${x},${y}`, axis: 'v', x, y, length: 2 }, { id: `e${x},${y}`, axis: 'v', x: x + 2, y, length: 2 });
  }
  const start = performance.now(), result = buildRegion(brief('macro', 1, cells, portals));
  const elapsed = performance.now() - start;
  assert.ok(portals.length > 400 && result.elements.length > 200, `${portals.length} portals, ${result.elements.length} pieces`);
  assert.ok(elapsed < 2000, `built in ${Math.round(elapsed)} ms`);
});
