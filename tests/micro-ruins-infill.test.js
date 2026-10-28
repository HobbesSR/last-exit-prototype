import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildRegion } from '../map/micro/region-types.ts';
import { createAccessMask, createFillMask, elementShapes, shapesOverlap } from '../map/micro/geometry.ts';
import { draw } from '../map/micro/random.ts';
import { microMetrics } from '../map/micro/metrics.ts';
import { circle, rect } from '../shared/shape.ts';
import { cellsOf } from './helpers/cells.js';

const size = 40;
const cells = cellsOf(30, 30, (x, y) => y < 14 || x < 14);
const brief = (seed = 7, owned = cells, extra = {}) => ({ id: 'ruins-infill', seed, type: 'ruins', cellSize: size, cells: owned,
  zones: [{ tier: 3, bonus: 0, lootChance: 1, cells: owned }], portals: [],
  hints: [{ axis: 'h', x: 0, y: 0, length: 30 }], ...extra });
const crates = r => r.elements.filter(e => e.label.startsWith('ruins-infill-crate-'));
const primary = r => r.elements.filter(e => !e.label.startsWith('ruins-infill-crate-'));
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const gap = (a, b) => Math.max(b.x - a.x - a.w, a.x - b.x - b.w, b.y - a.y - a.h, a.y - b.y - b.h);

// Reconstruct eligible slots independently, including slots whose density roll fails.
function eligible(input) {
  const mask = createFillMask(input), phaseX = Math.floor(draw(input.seed, 0, 0, 7) * 6), phaseY = Math.floor(draw(input.seed, 1, 0, 7) * 6);
  const owns = (x,y,w,h) => { for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++) if (!mask.has(i,j)) return false; return true; };
  return mask.cells.filter(c => ((c.x-phaseX)%6+6)%6 === 0 && ((c.y-phaseY)%6+6)%6 === 0).map(c => ({ ...c,
    w: 3 + Math.floor(draw(input.seed,c.x,c.y,2)*2), h: 3 + Math.floor(draw(input.seed,c.x,c.y,3)*2) }))
    .filter(({x,y,w,h}) => owns(x,y,w,h) && (owns(x,y-2,w,2) || owns(x+w,y,2,h) || owns(x,y+h,w,2) || owns(x-2,y,2,h)));
}

test('infill retains pinned primary geometry and traces, with deterministic cell order', () => {
  for (const [seed, hash, trace] of [[1,'464686bc3baff8f6dbc4d233d5645328f6ee344fd7391292db92ca6ec6ed2fa5',[9,65,15,1]],
    [7,'f69714ae4c8a0973a314bdac8118843d95ebdb09c5b75e732cc1f2467703229c',[11,85,22,4]],
    [11,'2b9efa654f76b2284a7fa164e71f5257080cab4a337be292c656a29e0a93f059',[11,79,24,1]]]) {
    const input = brief(seed), result = buildRegion(input);
    assert.equal(digest(primary(result)), hash);
    assert.deepEqual(['rooms','walls','debris','hintWalls'].map(k => result.manifest[k]), trace);

    assert.equal(result.manifest.infillCrates, crates(result).length);
    const reversed = buildRegion({ ...input, cells: [...cells].reverse() });
    assert.deepEqual(reversed.elements, result.elements);
    assert.deepEqual(reversed.loot, result.loot);
  }
});

test('infill respects all eligible slots, bypass rings, spacing, and loot clearance', () => {
  for (const density of [0.25, 1]) {
    const input = brief(7, cells, { parameters: { density, decay: 1 } }), result = buildRegion(input);
    const slots = eligible(input), access = createAccessMask(input), mask = createFillMask(input), all = crates(result);
    assert.ok(all.length > 0);
    for (const crate of all) {
      const b = { x: crate.x/size, y: crate.y/size, w: 1, h: 1 };
      assert.ok(slots.every(slot => gap(b, slot) >= 2));
      assert.ok(mask.contains(rect(crate.x, crate.y, size, size)));
      assert.ok(access.contains(rect(crate.x-2*size, crate.y-2*size, 5*size, 5*size)));
      for (const other of all) if (other !== crate) assert.ok(gap(b, {x:other.x/size,y:other.y/size,w:1,h:1}) >= 2);
    }
    const shapes = result.elements.flatMap(e => elementShapes(e, true));
    const radius = microMetrics({ cellSize: size, bodyProfile: 'cell' }).lootRadius;
    for (const site of result.loot) assert.ok(shapes.every(shape => !shapesOverlap(circle(site.x, site.y, radius), shape)));
  }
});

test('zero density and small fallback preserve their original outputs', () => {
  const zero = buildRegion(brief(7, cells, { parameters: { density: 0 }, hints: [] }));
  assert.equal(zero.manifest.infillCrates, 0);
  assert.equal(zero.elements.length, 0);
  const fallback = buildRegion(brief(7, cellsOf(20, 2), { hints: [] }));
  assert.equal(fallback.manifest.infillCrates, undefined);
  assert.equal(fallback.elements.length, 0);
});
