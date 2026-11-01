import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createFillMask, elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { cellsOf } from './helpers/cells.js';

/** Park's hedge-front experiment (#649, 42.30): off by default, set by `hedgeFronts`. */
const SIZE = 40, THOROUGH = { search: 'thorough' };
const brief = (id, seed, cells, portals, parameters) => ({ id, seed, type: 'park', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals, ...(parameters ? { parameters } : {}) });
/** micro-park's field, L and ring masks. */
const MASKS = {
  field: [cellsOf(40, 30), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 40, y: 20, length: 3 },
    { id: 'north', axis: 'h', x: 28, y: 0, length: 8 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 15 || x < 15), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 },
    { id: 'corner', axis: 'h', x: 18, y: 15, length: 6 }]],
  ring: [cellsOf(36, 36, (x, y) => x < 13 || x >= 23 || y < 13 || y >= 23), [{ id: 'north', axis: 'h', x: 15, y: 0, length: 4 },
    { id: 'hole', axis: 'v', x: 23, y: 16, length: 3 }, { id: 'west', axis: 'v', x: 0, y: 26, length: 3 }]],
};
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const kind = prefix => element => element.label.startsWith(`park-${prefix}`);
const boxOf = element => ({ x: element.x / SIZE, y: element.y / SIZE, w: element.template.w / SIZE, h: element.template.h / SIZE });

test('hedge fronts (#649 experiment) grow inward, keep the promise and leave no sealed open ground', () => {
  let sealed = 0, fronts = 0;
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of [1, 2, 3]) {
    const input = brief(name, seed, cells, portals, { density: 0, hedges: 0, hedgeFronts: 1 }), result = buildRegion(input);
    assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }, THOROUGH).errors, [], `${name} seed ${seed}`);
    const reversed = buildRegion({ ...input, cells: [...cells].reverse() });
    assert.deepEqual(reversed.elements, result.elements, `${name} seed ${seed} order`);
    // Front and sealed hedge fill whole cells. Every other fill cell is reached from a portal.
    const blocked = new Set();
    for (const e of result.elements.filter(e => kind('front')(e) || kind('sealed')(e))) {
      const b = boxOf(e);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) blocked.add(`${x},${y}`);
    }
    const owned = new Set(cells.map(c => `${c.x},${c.y}`)), reached = new Set(), queue = [];
    const visit = (x, y) => { const k = `${x},${y}`; if (owned.has(k) && !blocked.has(k) && !reached.has(k)) { reached.add(k); queue.push([x, y]); } };
    for (const p of portals) for (let i = 0; i < p.length; i++) p.axis === 'v' ? (visit(p.x, p.y + i), visit(p.x - 1, p.y + i)) : (visit(p.x + i, p.y), visit(p.x + i, p.y - 1));
    while (queue.length) { const [x, y] = queue.pop(); visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1); }
    assert.deepEqual(createFillMask(result.brief).cells.filter(c => !blocked.has(`${c.x},${c.y}`) && !reached.has(`${c.x},${c.y}`)), [], `${name} seed ${seed} sealed`);
    sealed += result.manifest.sealedCells; fronts += result.manifest.fronts;
  }
  assert.ok(fronts > 0 && sealed > 0, `${fronts} fronts, ${sealed} sealed cells`);
  // Off by default: no front counts in the manifest.
  assert.equal(buildRegion(brief('field', 1, ...MASKS.field)).manifest.fronts, undefined);
});
