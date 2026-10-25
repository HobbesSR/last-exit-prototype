import test from 'node:test';
import assert from 'node:assert/strict';
import { construct, convexPieces, disjoint } from '../shared/shape-construction.ts';
import { circle, convex, outline, polygon, rect, sharesArea, transform } from '../shared/shape.ts';

const area = shape => {
  if (shape.kind === 'rect') return shape.w * shape.h;
  const points = outline(shape);
  return Math.abs(points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a.x * b.y - a.y * b.x; }, 0)) / 2;
};
const total = shapes => shapes.reduce((sum, s) => sum + area(s), 0);
const overlapping = (a, b) => sharesArea(a, b, 1e-7);

/** Every piece convex (a circle passes through `disjoint` untouched), none overlapping another. */
function assertPieces(pieces, name = '') {
  for (const piece of pieces) {
    if (piece.kind === 'polygon') assert.ok(convex(piece.points) && piece.points.length <= 64, `${name} convex piece`);
    else assert.ok(piece.kind === 'rect' || piece.kind === 'circle', name);
    assert.ok(area(piece) > 0, `${name} piece has area`);
  }
  pieces.forEach((a, i) => pieces.slice(0, i).forEach(b => assert.equal(overlapping(a, b), false, `${name} pieces ${JSON.stringify([a, b])} overlap`)));
}

test('a union of rectangles breaks into rectangles, keeping its inputs\' coordinates exactly', () => {
  // An L of two overlapping boxes, in a fractional cell size.
  const size = 37.3, pieces = construct([rect(size, size, 3 * size, size), rect(size, size, size, 4 * size)]).pieces();
  assertPieces(pieces);
  assert.deepEqual(pieces, [rect(size, size, 3 * size, size), rect(size, 2 * size, size, 5 * size - 2 * size)]);
});

test('a rectilinear part is cut in rows or columns, whichever gives fewer', () => {
  // A comb with three teeth hanging down: rows give four pieces, columns five.
  const comb = construct([rect(0, 0, 50, 10), rect(0, 10, 10, 20), rect(20, 10, 10, 20), rect(40, 10, 10, 20)]).pieces();
  assert.deepEqual(comb, [rect(0, 0, 50, 10), rect(0, 10, 10, 20), rect(20, 10, 10, 20), rect(40, 10, 10, 20)]);
  // Turned, the same comb is fewest in columns.
  const turned = construct([rect(0, 0, 10, 50), rect(10, 0, 20, 10), rect(10, 20, 20, 10), rect(10, 40, 20, 10)]).pieces();
  assert.deepEqual(turned, [rect(0, 0, 10, 50), rect(10, 0, 20, 10), rect(10, 20, 20, 10), rect(10, 40, 20, 10)]);
  assertPieces(comb);
  assertPieces(turned);
  assert.equal(total(comb), 50 * 10 + 3 * 10 * 20);
});

test('subtraction leaves a frame round a hole, and nothing of what it cuts', () => {
  const frame = construct([rect(0, 0, 100, 60)]).subtract([rect(20, 20, 30, 20)]).pieces();
  assertPieces(frame);
  assert.equal(total(frame), 100 * 60 - 30 * 20);
  assert.equal(frame.some(p => overlapping(p, rect(20, 20, 30, 20))), false);
  assert.deepEqual(construct([rect(0, 0, 10, 10)]).subtract([rect(-5, -5, 20, 20)]).pieces(), []);
});

test('a cut on a slant leaves convex pieces that end on its surface', () => {
  const slab = transform(rect(0, 0, 60, 8), 30, -10, 0.6), wall = rect(10, 0, 10, 80);
  const pieces = construct([wall]).subtract([slab]).pieces();
  assertPieces(pieces);
  assert.equal(pieces.some(p => overlapping(p, slab)), false);
  assert.ok(Math.abs(total(pieces) - total(construct([wall]).pieces()) + total(construct([wall]).intersect([slab]).pieces())) < 1e-6);
});

test('intersection keeps only what both cover', () => {
  const both = construct([rect(0, 0, 40, 40)]).intersect([rect(30, 10, 40, 10), circle(0, 0, 10)]).pieces();
  assertPieces(both);
  assert.deepEqual(both.filter(p => p.kind === 'rect'), [rect(30, 10, 10, 10)]);
});

test('disjoint keeps each shape less the ones before it, and returns an untouched shape as it is', () => {
  // Walls meeting at a corner: the earlier keeps it.
  assert.deepEqual(disjoint([rect(0, 0, 320, 10), rect(0, 0, 10, 240)]), [rect(0, 0, 320, 10), rect(0, 10, 10, 230)]);
  // A wall wholly inside an earlier one, and a circle over one, add nothing; a circle clear of both is kept round.
  assert.deepEqual(disjoint([rect(0, 0, 40, 10), rect(10, 0, 20, 10), circle(5, 5, 3), circle(100, 100, 3)]), [rect(0, 0, 40, 10), circle(100, 100, 3)]);
  // Touching at an edge is not overlap.
  assert.deepEqual(disjoint([rect(0, 0, 10, 10), rect(10, 0, 10, 10)]), [rect(0, 0, 10, 10), rect(10, 0, 10, 10)]);
});

test('a concave or holed outline breaks into convex pieces covering it', () => {
  const l = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 }];
  const turned = l.map(p => ({ x: 100 + p.x * 0.8 - p.y * 0.6, y: 50 + p.x * 0.6 + p.y * 0.8 }));
  const pieces = convexPieces([turned]);
  assertPieces(pieces);
  assert.ok(Math.abs(total(pieces) - 500) < 1e-6);
  // An outer ring and a hole wound the other way.
  const square = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 50, y: 40 }, { x: 0, y: 40 }], hole = [{ x: 10, y: 10 }, { x: 10, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 10 }];
  const holed = convexPieces([square, hole]);
  assertPieces(holed);
  assert.ok(Math.abs(total(holed) - (40 * 40 + 10 * 40 / 2 - 100)) < 1e-6);
});

test('pieces never overlap one another or what was cut, over many rotated cuts', () => {
  let state = 488;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const round = v => Math.round(v * 1000) / 1000;
  const slab = () => {
    const turned = transform(rect(-8 - random() * 12, -3, 16 + random() * 24, 6 + random() * 4), 0, 0, random() * Math.PI);
    return polygon(round(random() * 120), round(random() * 120), turned.points.map(p => ({ x: round(p.x), y: round(p.y) })));
  };
  for (let run = 0; run < 150; run++) {
    const from = [rect(0, 0, 120, 10 + Math.floor(random() * 40)), slab(), slab()], cut = [slab(), slab(), circle(random() * 120, random() * 120, 3 + random() * 10)];
    const name = `run ${run}`, pieces = construct(from).subtract(cut).pieces();
    assertPieces(pieces, name);
    for (const c of cut) for (const p of pieces) assert.equal(overlapping(p, c), false, `${name} piece overlaps a cut ${JSON.stringify([p, c])}`);
    const kept = construct(from).intersect(cut).pieces();
    // A sliver thinner than a grid step, as where a corner barely crosses an edge, may be lost.
    assert.ok(Math.abs(total(pieces) + total(kept) - total(construct(from).pieces())) < 0.25, `${name} pieces cover the area`);
    assertPieces(disjoint([...from, ...cut]), `${name} disjoint`);
  }
});
