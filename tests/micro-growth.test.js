import test from 'node:test';
import assert from 'node:assert/strict';
import { createProspectiveParcels } from '../map/micro/prospective-parcels.ts';
import { frontStarts, growFront, growParcel, growSeed, portalSetback } from '../map/micro/growth.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { polygon, rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const size = 32;
const portals = [{ id: 'left', axis: 'v', x: 0, y: 3, length: 2 }, { id: 'right', axis: 'v', x: 12, y: 3, length: 2 }];
const brief = (overrides = {}) => ({ id: 'growth', seed: 1, type: 'test', cellSize: size, cells: cellsOf(12, 10), zones: [], portals, ...overrides });
const ready = (b = brief()) => { const r = createProspectiveParcels(b); assert.equal(r.ok, true, JSON.stringify(r)); return r.coordinator; };
const snapshot = c => ({ revision: c.revision, parcels: c.parcels, addressed: c.addressed.areas, elements: c.elements, witness: c.witness });
/** Thorough final-geometry proof, independent of the coordinator's witness (20.10). */
const reaches = (b, c) => validatePortalReach({ ...b, blockers: c.parcels.flatMap(p => p.area) }, { search: 'thorough' }).valid;

test('an interior seed expands outward until the cords stop it, with no edge attachment', () => {
  const b = brief(), c = ready(b);
  const grown = growSeed(c, [{ x: 6, y: 4 }]);
  assert.ok(grown.handle);
  assert.ok(grown.cells.some(cell => cell.x === 6 && cell.y === 4));
  assert.ok(grown.cells.length > 8, `${grown.cells.length} cells`);
  // It grew on every side of the seed.
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) assert.ok(grown.cells.some(cell => cell.x === 6 + dx && cell.y === 4 + dy));
  assert.equal(grown.stop, 'refused');
  assert.ok((grown.refusals.external ?? 0) > 0);
  assert.equal(c.parcels.length, 1);
  assert.ok(reaches(b, c));
});

test('a hinted frontage grows inward and stops where the cord could not get round it', () => {
  const b = brief({ hints: [{ axis: 'h', x: 4, y: 0, length: 4 }] }), c = ready(b);
  const starts = frontStarts(b, c.fill);
  const hinted = starts.filter(s => s.hinted);
  assert.deepEqual(hinted.map(s => s.cell), [4, 5, 6, 7].map(x => ({ x, y: 0 })));
  assert.ok(hinted.every(s => s.inward.x === 0 && s.inward.y === 1 && s.beyond === 'region'));
  const front = growFront(c, hinted[1].cell, hinted[1].inward, { width: 2 });
  // The whole height would cut the portals apart; a shallower front is admitted instead.
  assert.equal(front.reach, 10);
  assert.ok(front.depth > 0 && front.depth < front.reach, `${front.depth}`);
  assert.ok((front.refusals.external ?? 0) > 0);
  assert.deepEqual(front.cells.length, 2 * front.depth);
  assert.ok(front.attempts <= 1 + Math.ceil(Math.log2(front.reach)));
  assert.ok(reaches(b, c));
  // Grown as deep as admitted, it pins the cord along the far edge: an opposing front gets nothing.
  assert.equal(growFront(c, { x: 8, y: 9 }, { x: 0, y: -1 }, { width: 2 }).depth, 0);
});

test('opposing capped fronts interleave and push the cord into a detour', () => {
  const b = brief(), c = ready(b);
  // Depth caps are builder policy: they leave the cord room to pass between fronts.
  assert.equal(growFront(c, { x: 3, y: 0 }, { x: 0, y: 1 }, { width: 2, depth: 7 }).depth, 7);
  assert.equal(growFront(c, { x: 7, y: 9 }, { x: 0, y: -1 }, { width: 2, depth: 7 }).depth, 7);
  const [, path] = c.witness.paths, length = path.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
  assert.ok(length > 1.5 * 12 * size, `${length}`);
  assert.ok(reaches(b, c));
});

test('a front that would cross a cord either moves it or is refused without mutation', () => {
  const b = brief(), c = ready(b), before = c.witness;
  // Short enough to leave room: the cord moves round it.
  const moved = growFront(c, { x: 6, y: 0 }, { x: 0, y: 1 }, { depth: 5 });
  assert.equal(moved.depth, 5);
  assert.equal(moved.attempts, 1);
  assert.notDeepEqual(c.witness, before);
  // A full-height cut with one probe allowed: nothing is admitted and nothing changes.
  const saved = snapshot(c);
  const cut = growFront(c, { x: 9, y: 0 }, { x: 0, y: 1 }, { attempts: 1 });
  assert.equal(cut.handle, null);
  assert.equal(cut.depth, 0);
  assert.deepEqual(cut.refusals, { external: 1 });
  assert.deepEqual(snapshot(c), saved);
});

test('growth is deterministic and bounded, with refusal reasons', () => {
  const run = limits => { const c = ready(); return { report: growSeed(c, [{ x: 6, y: 4 }], limits), state: snapshot(c) }; };
  assert.deepEqual(run({}), run({}));
  const bounded = run({ attempts: 3 });
  assert.equal(bounded.report.stop, 'attempts');
  assert.equal(bounded.report.attempts, 3);
  const stepped = run({ steps: 2 });
  assert.equal(stepped.report.stop, 'steps');
  assert.equal(stepped.report.taken.length, 2);
  // An occupied seed is an allocation refusal, not a cord refusal.
  const c = ready();
  assert.equal(c.tryClaim([rect(6 * size, 4 * size, size, size)]).ok, true);
  const blocked = growSeed(c, [{ x: 6, y: 4 }]);
  assert.equal(blocked.handle, null);
  assert.deepEqual(blocked.refusals, { allocation: 1 });
  // `admit` prunes the seed itself, all or nothing, with no probe and no allocation.
  const free = ready(), before = snapshot(free);
  const pruned = growSeed(free, [{ x: 3, y: 4 }, { x: 4, y: 4 }], { admit: cell => cell.x !== 4 });
  assert.deepEqual(pruned, { handle: null, taken: [], attempts: 0, refusals: { pruned: 1 }, stop: 'refused', cells: [] });
  assert.deepEqual(snapshot(free), before);
  assert.equal(growSeed(free, [{ x: 5, y: 5 }], { admit: () => false }).handle, null);
  assert.deepEqual(free.parcels, []);
  assert.throws(() => growSeed(c, [], {}), TypeError);
  assert.throws(() => growFront(c, { x: 1, y: 1 }, { x: 1, y: 1 }), TypeError);
  assert.throws(() => growParcel(c, () => [], { attempts: -1 }), RangeError);
});

test('a custom loop grows polygon wedges through the same transaction', () => {
  const b = brief(), c = ready(b);
  // A builder's own candidates: triangles stepping in from the top edge.
  const wedge = n => [polygon(0, 0, [{ x: 5 * size, y: n * size }, { x: 7 * size, y: n * size }, { x: 6 * size, y: (n + 1) * size }])];
  const grown = growParcel(c, taken => taken.length < 12 ? [{ shapes: [rect(5 * size, taken.length * size, 2 * size, size)], value: 'box' },
    { shapes: wedge(taken.length), value: 'wedge' }] : []);
  assert.ok(grown.taken.includes('box'));
  assert.ok(grown.taken.length < 12);
  assert.equal(grown.stop, 'refused');
  assert.ok(reaches(b, c));
});

test('the portal setback prunes fronts beside a portal; starts carry what lies beyond', () => {
  const b = brief(), near = portalSetback(b);
  assert.ok(near.has('0,3') && near.has('2,5') && near.has('1,1'));
  assert.ok(!near.has('3,3') && !near.has('0,0'));
  const c = ready(b);
  const starts = frontStarts(b, c.fill).filter(s => !near.has(`${s.cell.x},${s.cell.y}`));
  assert.ok(starts.every(s => !(s.cell.x <= 2 && s.cell.y >= 1 && s.cell.y <= 6)));
  const pruned = growFront(c, { x: 3, y: 2 }, { x: -1, y: 0 }, { admit: cell => !near.has(`${cell.x},${cell.y}`) });
  assert.equal(pruned.reach, 1);
  assert.equal(portalSetback(b, 0).size, 4);
});
