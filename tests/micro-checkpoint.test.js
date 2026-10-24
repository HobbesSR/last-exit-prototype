import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';
import { portalMargin } from '../map/micro/hints.ts';
import { bounds } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const SIZE = 40;
const brief = (id, seed, cells, portals) => ({ id, seed, type: 'checkpoint', cellSize: SIZE, cells,
  zones: [{ tier: 3, bonus: 0, lootChance: 0.4, cells }], portals });

const MASKS = {
  lane: [cellsOf(30, 6), [{ id: 'west', axis: 'v', x: 0, y: 1, length: 3 }, { id: 'east', axis: 'v', x: 30, y: 2, length: 3 }]],
  narrow: [cellsOf(24, 3), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 0, length: 3 }]],
  tall: [cellsOf(7, 26), [{ id: 'north', axis: 'h', x: 1, y: 0, length: 4 }, { id: 'south', axis: 'h', x: 2, y: 26, length: 3 }]],
  yard: [cellsOf(24, 18), [{ id: 'west', axis: 'v', x: 0, y: 7, length: 3 }, { id: 'east', axis: 'v', x: 24, y: 12, length: 3 },
    { id: 'north', axis: 'h', x: 18, y: 0, length: 2 }]],
  ell: [cellsOf(30, 30, (x, y) => y < 12 || x < 12), [{ id: 'east', axis: 'v', x: 30, y: 4, length: 3 }, { id: 'south', axis: 'h', x: 2, y: 30, length: 4 }]],
  one: [cellsOf(20, 16), [{ id: 'west', axis: 'v', x: 0, y: 6, length: 3 }]],
  none: [cellsOf(20, 16), []],
  tiny: [cellsOf(8, 4), [{ id: 'west', axis: 'v', x: 0, y: 0, length: 4 }, { id: 'east', axis: 'v', x: 8, y: 0, length: 4 }]],
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const blockers = result => result.elements.flatMap(element => elementShapes(element));
const barriers = result => result.elements.filter(e => e.label.startsWith('checkpoint-barrier'));
const posts = result => result.elements.filter(e => e.label.startsWith('checkpoint-post'));

test('a large checkpoint reuses route evidence and still passes the independent portal check', () => {
  const w = 156, h = 18, cells = cellsOf(w, h), portals = [], hints = [];
  for (let x = 0; x < w; x += 6) for (const y of [0, h]) {
    portals.push({ id: `h-${x}-${y}`, axis: 'h', x: x + 3, y, length: 3 });
    hints.push({ axis: 'h', x, y, length: 3 });
  }
  for (let y = 0; y < h; y += 6) for (const x of [0, w]) {
    portals.push({ id: `v-${x}-${y}`, axis: 'v', x, y: y + 3, length: 3 });
    hints.push({ axis: 'v', x, y, length: 3 });
  }
  const input = { ...brief('large-checkpoint', 3, cells, portals), hints };
  // CPU time, not wall time: parallel test files contend for cores, and that isn't this work.
  const start = process.cpuUsage(), result = buildRegion(input), spent = process.cpuUsage(start);
  assert.ok((spent.user + spent.system) / 1000 < 5000, 'generation remains bounded with 58 portals');
  assert.ok(barriers(result).length > 10, 'the speedup preserves the chicane');
  assert.deepEqual(validatePortalReach({ ...input, blockers: blockers(result) }).errors, []);
});

test('a checkpoint keeps the portal promise over shapes and seeds', () => {
  for (const [name, [cells, portals]] of Object.entries(MASKS)) for (const seed of SEEDS) {
    const result = buildRegion(brief(name, seed, cells, portals));
    const check = validatePortalReach({ ...result.brief, blockers: blockers(result) });
    assert.deepEqual(check.errors, [], `${name} seed ${seed}`);
  }
});

test('checkpoints are deterministic and independent of the order of the brief\'s cells', () => {
  const [cells, portals] = MASKS.yard;
  for (const seed of SEEDS) assert.deepEqual(buildRegion(brief('yard', seed, [...cells].reverse(), portals)).elements, buildRegion(brief('yard', seed, cells, portals)).elements);
});

test('barriers alternate sides across the line, ruin walls that block sight', () => {
  const [cells, portals] = MASKS.lane;
  for (const seed of SEEDS) {
    const result = buildRegion(brief('lane', seed, cells, portals)), walls = barriers(result);
    assert.ok(walls.length >= 3, `seed ${seed} stands barriers`);
    assert.equal(result.manifest.barriers, walls.length);
    const attached = walls.map(w => w.y < 1 ? 'top' : 'bottom');
    for (const wall of walls) assert.equal(wall.template.parts[0].kind, 'ruin-wall');
    walls.slice(1).forEach((_, i) => assert.notEqual(attached[i], attached[i + 1], `seed ${seed} alternates`));
  }
});

/** Free intervals of `run` once every `[from, to]` in `blocked` is removed, in cells. */
const freeIntervals = (run, blocked) => {
  let free = [run];
  for (const [from, to] of blocked) free = free.flatMap(([a, b]) => [[a, Math.min(b, from)], [Math.max(a, to), b]].filter(([c, d]) => d - c > 1e-9));
  return free;
};

test('each barrier leaves a gap a door wide, and a narrow lane still takes one', () => {
  for (const name of ['lane', 'narrow', 'tall']) {
    const [cells, portals] = MASKS[name];
    let walls = 0;
    for (const seed of SEEDS) {
      const input = brief(name, seed, cells, portals), result = buildRegion(input), mask = createRegionMask(input);
      const pieces = blockers(result).map(bounds).map(b => ({ x: b.x / SIZE, y: b.y / SIZE, w: b.w / SIZE, h: b.h / SIZE }));
      for (const wall of barriers(result)) {
        walls++;
        const x = wall.x / SIZE, y = wall.y / SIZE, w = wall.template.w / SIZE, h = wall.template.h / SIZE;
        // The cross-section the barrier spans: the row through it if it lies along x, else the column.
        const along = w > h, line = along ? y + h / 2 : x + w / 2, span = along ? [x, x + w] : [y, y + h];
        const owned = i => along ? mask.has(i, Math.floor(line)) : mask.has(Math.floor(line), i);
        let from = Math.floor(span[0]), to = from;
        assert.ok(owned(from), `${name} ${seed} ${wall.label} stands in the region`);
        while (owned(from - 1)) from--;
        while (owned(to)) to++;
        assert.ok(span[1] - span[0] > 0 && span[0] >= from && span[1] <= to, `${name} ${seed} ${wall.label} lies across its owned run`);
        const blocked = pieces.filter(p => along ? p.y < line && p.y + p.h > line : p.x < line && p.x + p.w > line)
          .map(p => along ? [p.x, p.x + p.w] : [p.y, p.y + p.h]);
        const widest = Math.max(0, ...freeIntervals([from, to], blocked).map(([a, b]) => b - a));
        assert.ok(widest >= 2 - 1e-9, `${name} ${seed} ${wall.label} leaves a contiguous doorway; widest gap ${widest}`);
      }
    }
    assert.ok(walls > 0, `${name} stands barriers to check`);
  }
  assert.ok(barriers(buildRegion(brief('narrow', 1, ...MASKS.narrow))).length >= 1, 'a 3-cell lane is chicaned');
});

test('the post is roofed, fits the region and stays clear of portals and barriers', () => {
  for (const name of ['lane', 'yard', 'tall']) {
    const [cells, portals] = MASKS[name];
    for (const seed of SEEDS) {
      const input = brief(name, seed, cells, portals), result = buildRegion(input), mask = createRegionMask(input);
      const [post] = posts(result);
      if (!post) continue;
      assert.equal(posts(result).length, 1);
      const box = { x: post.x / SIZE, y: post.y / SIZE, w: post.template.w / SIZE, h: post.template.h / SIZE };
      assert.ok(box.w >= 5 && box.h >= 5 && Math.max(box.w, box.h) >= 6, `${name} ${seed}: ${box.w} x ${box.h}`);
      assert.ok(post.template.encloses, `${name} ${seed} post is roofed`);
      const portalCells = new Set(portalMargin(input, 1).map(c => `${c.x},${c.y}`));
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
        assert.ok(mask.has(x, y), `${name} ${seed} post stays inside`);
        assert.ok(!portalCells.has(`${x},${y}`), `${name} ${seed} post stays out of portal cells`);
      }
      for (const wall of barriers(result)) {
        const b = { x: wall.x / SIZE, y: wall.y / SIZE, w: wall.template.w / SIZE, h: wall.template.h / SIZE };
        assert.ok(Math.max(b.x - (box.x + box.w), box.x - (b.x + b.w), b.y - (box.y + box.h), box.y - (b.y + b.h)) >= 2, `${name} ${seed} ${wall.label} keeps its aisle from the post`);
      }
    }
  }
  const built = buildRegion(brief('yard', 1, ...MASKS.yard));
  assert.equal(built.manifest.posts, posts(built).length);
  assert.equal(built.manifest.structures, posts(built).length);
});

test('hinted perimeter post boxes are preferred and keep every portal reachable', () => {
  const cells = cellsOf(30, 22);
  const input = { ...brief('hinted', 4, cells, [
    { id: 'west', axis: 'v', x: 0, y: 9, length: 3 }, { id: 'east', axis: 'v', x: 30, y: 9, length: 3 },
  ]), hints: [
    { axis: 'h', x: 0, y: 0, length: 30 }, { axis: 'h', x: 0, y: 22, length: 30 },
  ] };
  const result = buildRegion(input), post = posts(result)[0];
  assert.ok(post, 'checkpoint sites its post');
  const box = { x: post.x / SIZE, y: post.y / SIZE, w: post.template.w / SIZE, h: post.template.h / SIZE };
  assert.ok(box.y === 0 || box.y + box.h === 22 || box.x === 0 || box.x + box.w === 30,
    `post is flush with a hinted edge: ${JSON.stringify(box)}`);
  assert.deepEqual(validatePortalReach({ ...result.brief, blockers: blockers(result) }).errors, []);
});

test('a one-portal or portalless region is a post alone, and a region with no room is open', () => {
  for (const name of ['one', 'none']) for (const seed of SEEDS) {
    const result = buildRegion(brief(name, seed, ...MASKS[name]));
    assert.equal(barriers(result).length, 0, `${name} ${seed} has no barriers`);
    assert.equal(posts(result).length, 1, `${name} ${seed} has a post`);
  }
  for (const seed of SEEDS) assert.deepEqual(buildRegion(brief('tiny', seed, ...MASKS.tiny)).elements.filter(e => e.label.startsWith('checkpoint-post')), []);
});

test('the post reports its design to an observer', () => {
  const seen = [];
  buildRegion(brief('yard', 1, ...MASKS.yard), undefined, building => seen.push(building.label));
  assert.deepEqual(seen, ['checkpoint-post-1']);
});
