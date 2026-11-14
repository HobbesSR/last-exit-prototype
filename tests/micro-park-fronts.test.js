import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createFillMask } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { SIZE, THOROUGH, brief, MASKS as PARK_MASKS, blockers, kind, boxOf } from './helpers/park-fixtures.js';

/** Park's hedge fronts (#649, 42.30), on by default since #760; `hedgeFronts: 0` turns them off. */

/** micro-park's field, L and ring masks. */
const MASKS = { field: PARK_MASKS.field, ell: PARK_MASKS.ell, ring: PARK_MASKS.ring };

test('hedge fronts (#649, #760) grow inward, keep the promise and leave no sealed open ground', () => {
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
  // On by default (#760); `hedgeFronts: 0` leaves no front and no front counts in the manifest.
  assert.ok(buildRegion(brief('field', 1, ...MASKS.field)).manifest.fronts > 0);
  const off = buildRegion(brief('field', 1, ...MASKS.field, { hedgeFronts: 0 }));
  assert.equal(off.manifest.fronts, undefined);
  assert.equal(off.elements.some(kind('front')), false);
});
