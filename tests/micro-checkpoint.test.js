import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegion } from '../map/micro/region-types.ts';
import { createRegionMask, elementShapes } from '../map/micro/geometry.ts';
import { validatePortalReach } from '../map/micro/portals.ts';

const SIZE = 40;
const cellsOf = (w, h, keep = () => true) => {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep(x, y)) cells.push({ x, y });
  return cells;
};
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

test('each barrier leaves a gap a door wide, and a narrow lane still takes one', () => {
  for (const name of ['lane', 'narrow', 'tall']) {
    const [cells, portals] = MASKS[name];
    for (const seed of SEEDS) {
      const input = brief(name, seed, cells, portals), result = buildRegion(input), mask = createRegionMask(input);
      for (const wall of barriers(result)) {
        const x = wall.x / SIZE, y = wall.y / SIZE, w = wall.template.w / SIZE, h = wall.template.h / SIZE;
        const long = Math.max(w, h), cross = w > h ? [y, y + h] : [x, x + w];
        // The column's run of owned cells, minus the barrier, leaves at least 2 free.
        let owned = 0;
        for (let i = 0; i < 40; i++) if (w > h ? mask.has(Math.floor(x + w / 2), i) : mask.has(i, Math.floor(y + h / 2))) owned++;
        assert.ok(owned - long >= 2 - 1e-9, `${name} ${seed} ${wall.label} leaves a doorway`);
        assert.ok(cross[1] > cross[0]);
      }
    }
  }
  assert.ok(barriers(buildRegion(brief('narrow', 1, ...MASKS.narrow))).length >= 1, 'a 3-cell lane is chicaned');
});

test('the post is a roofed building beside the barriers, clear of them and the edge', () => {
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
      for (let y = box.y - 2; y < box.y + box.h + 2; y++) for (let x = box.x - 2; x < box.x + box.w + 2; x++) assert.ok(mask.has(x, y), `${name} ${seed} keeps its edge aisle`);
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
