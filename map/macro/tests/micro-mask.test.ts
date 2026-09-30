import test from "node:test";
import assert from "node:assert/strict";
import { createRng } from "../src/micro/rng.ts";
import { createMask } from "../src/micro/mask.ts";
import type { Box } from "../src/types.ts";
import type { CellRef } from "../src/micro/types.ts";

const W = 10;
const H = 10;

/** Cell indices of an inclusive box, in the project's `y * width + x` order. */
function boxCells(x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) out.push(y * W + x);
  return out;
}

const at = (c: CellRef): [number, number] => [c.x, c.y];
const draws = (rng: { next(): number }, n: number): number[] =>
  Array.from({ length: n }, () => rng.next());

/* -------------------------------------------------------------- rng ------ */

test("a stream is a pure function of its seed", () => {
  assert.deepEqual(
    draws(createRng("region-7"), 8),
    draws(createRng("region-7"), 8),
  );
  // A number and the text of that number are the same seed: MapRegion.seed is
  // a number and authored seeds are text.
  assert.deepEqual(draws(createRng(1234), 8), draws(createRng("1234"), 8));
  assert.notDeepEqual(
    draws(createRng("region-7"), 8),
    draws(createRng("region-8"), 8),
  );
  // Neighbouring seeds must not produce neighbouring streams.
  const a = createRng("a").next();
  const b = createRng("b").next();
  assert.ok(
    Math.abs(a - b) > 0.01,
    `seeds a and b landed together: ${a}, ${b}`,
  );
});

test("drawing from a child never perturbs the parent", () => {
  const clean = createRng("root");
  const expected = draws(clean, 6);

  const dirty = createRng("root");
  const got: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    // Interleave a child that draws far more than the parent does.
    draws(dirty.stream(`noise-${i}`), 20);
    got.push(dirty.next());
  }
  assert.deepEqual(got, expected);
});

test("a child does not care what the parent has drawn", () => {
  const early = createRng("root");
  const beforeAnything = draws(early.stream("walls"), 5);
  draws(early, 37);
  const afterPlenty = draws(early.stream("walls"), 5);
  assert.deepEqual(afterPlenty, beforeAnything);

  // And a stream reached the same way through a different parent object.
  assert.deepEqual(draws(createRng("root").stream("walls"), 5), beforeAnything);
  // Nesting composes: the path is the identity, not the object.
  assert.deepEqual(
    draws(createRng("root").stream("walls").stream("gaps"), 5),
    draws(createRng("root").stream("walls").stream("gaps"), 5),
  );
});

test("siblings are independent of creation and consumption order", () => {
  const forward = createRng("root");
  const wallsFirst = forward.stream("walls");
  const propsFirst = forward.stream("props");
  const orderA = [draws(wallsFirst, 4), draws(propsFirst, 4)];

  const backward = createRng("root");
  // Created in the other order, and drained in the other order.
  const props = backward.stream("props");
  const walls = backward.stream("walls");
  const orderB = [draws(props, 4), draws(walls, 4)];

  assert.deepEqual(orderA[0], orderB[1]);
  assert.deepEqual(orderA[1], orderB[0]);
  // Different names are different streams, which is the other half of the deal.
  assert.notDeepEqual(orderA[0], orderA[1]);
});

test("int is inclusive at both ends and answers an empty range with min", () => {
  const rng = createRng("ints");
  const seen = new Set<number>();
  for (let i = 0; i < 400; i += 1) seen.add(rng.int(3, 6));
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [3, 4, 5, 6],
  );
  assert.equal(rng.int(5, 5), 5);
  // Documented: a reversed range is the floor the caller asked for, not a throw.
  assert.equal(rng.int(9, 2), 9);
  assert.equal(rng.int(-4, -4), -4);
});

test("range and chance sit inside their stated bounds", () => {
  const rng = createRng("bounds");
  for (let i = 0; i < 200; i += 1) {
    const v = rng.range(2, 5);
    assert.ok(v >= 2 && v < 5, `range escaped: ${v}`);
  }
  assert.equal(rng.chance(0), false);
  assert.equal(rng.chance(1), true);
  assert.equal(rng.chance(-1), false);
});

test("pick and shuffle never touch the caller's array", () => {
  const rng = createRng("draw");
  const items = Object.freeze(["a", "b", "c", "d", "e"]);

  // Frozen input: a mutating implementation throws here under strict mode.
  for (let i = 0; i < 50; i += 1) assert.ok(items.includes(rng.pick(items)!));
  assert.deepEqual([...items], ["a", "b", "c", "d", "e"]);

  const shuffled = rng.shuffle(items);
  assert.notEqual(shuffled, items as unknown as string[]);
  assert.deepEqual([...items], ["a", "b", "c", "d", "e"]);
  assert.deepEqual([...shuffled].sort(), [...items].sort());
  // Deterministic, and it does eventually reorder.
  assert.deepEqual(
    createRng("s").shuffle(items),
    createRng("s").shuffle(items),
  );
  assert.ok(
    Array.from({ length: 20 }, (_, i) =>
      createRng(`s${i}`).shuffle(items).join(""),
    ).some((order) => order !== "abcde"),
  );

  assert.equal(rng.pick([]), undefined);
  assert.deepEqual(rng.shuffle([]), []);
});

/* ------------------------------------------------------------- mask ------ */

/**
 * A 7 x 5 block with one cell punched out of the middle. Small enough that the
 * distance transform and the rectangle sweep can be checked by hand, and
 * concave enough that neither can be right by accident.
 *
 *   x 1234567
 * y1  #######
 * y2  #######
 * y3  ###.###
 * y4  #######
 * y5  #######
 */
const HOLE = 3 * W + 4;
const holed = createMask(
  boxCells(1, 1, 7, 5).filter((i) => i !== HOLE),
  W,
  H,
);

/**
 * An L: a 2 x 7 upright with a 6 x 2 foot. The arms differ in area on purpose,
 * so "the largest rectangle" has one answer rather than a tie.
 */
const ell = createMask(
  [...new Set([...boxCells(2, 2, 3, 8), ...boxCells(2, 7, 7, 8)])],
  W,
  H,
);

test("a mask reports the shape it was given, not the box around it", () => {
  assert.equal(holed.width, W);
  assert.equal(holed.height, H);
  assert.deepEqual(holed.bounds, [1, 1, 7, 5]);
  assert.equal(holed.area, 34);
  assert.equal(holed.cells.length, 34);

  // Ascending by cell index, which is what every consumer downstream assumes.
  const indices = holed.cells.map((c) => c.cellIndex);
  assert.deepEqual(
    [...indices].sort((a, b) => a - b),
    indices,
  );
  assert.deepEqual(at(holed.cells[0]!), [1, 1]);

  assert.equal(holed.has(1, 1), true);
  assert.equal(holed.has(4, 3), false, "the hole is not in the region");
  assert.equal(holed.has(0, 1), false);
  assert.equal(holed.has(8, 3), false);
  assert.equal(holed.has(4, 6), false);
  assert.equal(holed.indexOf(2, 3), 3 * W + 2);
  assert.equal(holed.indexOf(4, 3), -1);
  assert.equal(holed.indexOf(-1, -1), -1);

  assert.deepEqual(ell.bounds, [2, 2, 7, 8]);
  assert.equal(ell.area, 2 * 7 + 6 * 2 - 2 * 2);
  assert.equal(ell.has(7, 2), false);
  assert.equal(ell.has(7, 8), true);
});

test("depth is Chebyshev distance to the nearest cell outside", () => {
  // Outside the region at all: zero, whether or not it is inside the box.
  assert.equal(holed.depthAt(4, 3), 0);
  assert.equal(holed.depthAt(0, 0), 0);
  assert.equal(holed.depthAt(99, 99), 0);

  // Against the outer edge: one.
  assert.equal(holed.depthAt(1, 1), 1);
  assert.equal(holed.depthAt(7, 5), 1);
  assert.equal(holed.depthAt(4, 1), 1);

  // Against the hole: also one, which is the whole reason for a transform
  // rather than a distance to the bounding box.
  assert.equal(holed.depthAt(3, 3), 1);
  assert.equal(holed.depthAt(5, 3), 1);
  assert.equal(holed.depthAt(4, 2), 1);
  assert.equal(holed.depthAt(5, 2), 1, "diagonal neighbours count");
  assert.equal(holed.depthAt(3, 4), 1);

  // Two clear of everything: two. Note (2, 3) is two from the hole and two
  // from the left edge, so the transform has to take a minimum over both.
  assert.equal(holed.depthAt(2, 2), 2);
  assert.equal(holed.depthAt(2, 3), 2);
  assert.equal(holed.depthAt(2, 4), 2);
  assert.equal(holed.depthAt(6, 2), 2);
  assert.equal(holed.depthAt(6, 3), 2);
  assert.equal(holed.depthAt(6, 4), 2);

  // A 2-wide arm is border all the way down.
  for (const cell of ell.cells) assert.equal(ell.depthAt(cell.x, cell.y), 1);

  // The unpunched block does reach depth 3, so the cap above is the shape's.
  const solid = createMask(boxCells(1, 1, 7, 5), W, H);
  assert.equal(solid.depthAt(4, 3), 3);
  assert.equal(solid.depthAt(3, 3), 3);
  assert.equal(solid.depthAt(3, 2), 2);
});

test("interior and border are the two ends of depth", () => {
  assert.deepEqual(holed.interior(2).map(at), [
    [2, 2],
    [6, 2],
    [2, 3],
    [6, 3],
    [2, 4],
    [6, 4],
  ]);
  assert.deepEqual(holed.interior(3), []);
  // interior(1) is every cell, and border is its complement in the region.
  assert.equal(holed.interior(1).length, holed.area);
  assert.equal(holed.border().length, holed.area - holed.interior(2).length);
  assert.ok(holed.border().every((c) => holed.depthAt(c.x, c.y) === 1));
  assert.equal(ell.border().length, ell.area);
  assert.deepEqual(ell.interior(2), []);
});

test("within clips to an inclusive sub-box and keeps index order", () => {
  const near = holed.within([2, 2, 4, 4]);
  assert.deepEqual(near.map(at), [
    [2, 2],
    [3, 2],
    [4, 2],
    [2, 3],
    [3, 3],
    [2, 4],
    [3, 4],
    [4, 4],
  ]);
  // A box larger than the region clips to the region.
  assert.equal(holed.within([0, 0, W - 1, H - 1]).length, holed.area);
  assert.deepEqual(holed.within([0, 0, 0, 0]), []);
  assert.deepEqual(holed.within([4, 3, 4, 3]), [], "the hole stays a hole");
  assert.deepEqual(holed.within([1, 1, 1, 1]).map(at), [[1, 1]]);
});

test("rects enumerates exactly the maximal rectangles", () => {
  // By hand: the hole splits the block into two 3 x 5 columns and two 7 x 2
  // bands. Nothing else can be grown no further in all four directions.
  assert.deepEqual(holed.rects(1, 1), [
    [1, 1, 3, 5],
    [5, 1, 7, 5],
    [1, 1, 7, 2],
    [1, 4, 7, 5],
  ] satisfies Box[]);

  // The minimum filters that set; it does not change what is maximal.
  assert.deepEqual(holed.rects(7, 1), [
    [1, 1, 7, 2],
    [1, 4, 7, 5],
  ] satisfies Box[]);
  assert.deepEqual(holed.rects(1, 5), [
    [1, 1, 3, 5],
    [5, 1, 7, 5],
  ] satisfies Box[]);
  assert.deepEqual(holed.rects(4, 4), []);

  // A solid box is one rectangle, not a family of slices.
  assert.deepEqual(createMask(boxCells(2, 3, 5, 5), W, H).rects(1, 1), [
    [2, 3, 5, 5],
  ] satisfies Box[]);

  // The L is its two arms and nothing else.
  assert.deepEqual(ell.rects(1, 1), [
    [2, 2, 3, 8],
    [2, 7, 7, 8],
  ] satisfies Box[]);
  assert.deepEqual(ell.rects(3, 3), []);
});

test("largestRect honours the minimum it was given", () => {
  // The upright is 14 cells, the foot 12: the arm, not the foot.
  assert.deepEqual(ell.largestRect(), [2, 2, 3, 8]);
  // Ask for something wider than the upright and the foot is the only answer.
  assert.deepEqual(ell.largestRect(3, 1), [2, 7, 7, 8]);
  assert.deepEqual(ell.largestRect(1, 7), [2, 2, 3, 8]);
  assert.equal(ell.largestRect(7, 7), null);
  assert.deepEqual(holed.largestRect(), [1, 1, 3, 5]);
  assert.deepEqual(holed.largestRect(7, 2), [1, 1, 7, 2]);
});

test("rects stays near-linear on a region far too big to brute force", () => {
  // 40 x 30 with a diagonal of holes: 1200 cells, and O(n^4) over boxes would
  // be astronomical. This is a guard on the algorithm, not a benchmark.
  const wide = 40;
  const tall = 30;
  const cells: number[] = [];
  for (let y = 0; y < tall; y += 1)
    for (let x = 0; x < wide; x += 1)
      if (x % 7 !== y % 7) cells.push(y * wide + x);
  const started = Date.now();
  const mask = createMask(cells, wide, tall);
  const found = mask.rects(2, 2);
  assert.ok(found.length > 0);
  assert.ok(Date.now() - started < 1000, "the rectangle sweep is not linear");
  // Every rectangle it named is genuinely solid region.
  for (const [x0, y0, x1, y1] of found)
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1)
        assert.ok(
          mask.has(x, y),
          `rect ${[x0, y0, x1, y1]} leaks at ${x},${y}`,
        );
  // And is genuinely maximal: no single row or column may be added.
  const solidRow = (y: number, x0: number, x1: number): boolean => {
    for (let x = x0; x <= x1; x += 1) if (!mask.has(x, y)) return false;
    return true;
  };
  const solidCol = (x: number, y0: number, y1: number): boolean => {
    for (let y = y0; y <= y1; y += 1) if (!mask.has(x, y)) return false;
    return true;
  };
  for (const [x0, y0, x1, y1] of found) {
    assert.ok(!solidRow(y0 - 1, x0, x1), `rect ${[x0, y0, x1, y1]} grows up`);
    assert.ok(!solidRow(y1 + 1, x0, x1), `rect ${[x0, y0, x1, y1]} grows down`);
    assert.ok(!solidCol(x0 - 1, y0, y1), `rect ${[x0, y0, x1, y1]} grows left`);
    assert.ok(
      !solidCol(x1 + 1, y0, y1),
      `rect ${[x0, y0, x1, y1]} grows right`,
    );
  }
});

test("lattice(2, 1, 1) is the candidate set core.generateMicro already uses", () => {
  // core.ts generateMicro: region.cells.filter(i => x % 2 === 1 && y % 2 === 1).
  const expected = holed.cells.filter((c) => c.x % 2 === 1 && c.y % 2 === 1);
  assert.deepEqual(holed.lattice(2, 1, 1), expected);
  assert.deepEqual(holed.lattice(2, 1, 1).map(at), [
    [1, 1],
    [3, 1],
    [5, 1],
    [7, 1],
    [1, 3],
    [3, 3],
    [5, 3],
    [7, 3],
    [1, 5],
    [3, 5],
    [5, 5],
    [7, 5],
  ]);

  // The same check against a region-shaped cell list on a map-sized grid,
  // written the way core.ts writes it: index in, x and y derived, predicate
  // applied. Deliberately not importing core.ts -- this file is a unit test of
  // the mask, and the equivalence is in the predicate, not in the caller.
  const gridW = 72;
  const wideCells: number[] = [];
  for (let y = 4; y < 27; y += 1)
    for (let x = 9; x < 38; x += 1)
      if ((x * 7 + y * 13) % 11 !== 0) wideCells.push(y * gridW + x);
  const real = createMask(wideCells, gridW, 42);
  assert.equal(real.area, wideCells.length);
  assert.deepEqual(
    real.lattice(2, 1, 1).map((c) => c.cellIndex),
    wideCells.filter((i) => {
      const x = i % gridW;
      const y = (i - x) / gridW;
      return x % 2 === 1 && y % 2 === 1;
    }),
  );

  // Phases are reduced into the step, and the four phases of step 2 partition.
  assert.deepEqual(holed.lattice(2, 3, 3), holed.lattice(2, 1, 1));
  assert.deepEqual(holed.lattice(2, -1, -1), holed.lattice(2, 1, 1));
  const partition = [0, 1].flatMap((px) =>
    [0, 1].flatMap((py) => holed.lattice(2, px, py).map((c) => c.cellIndex)),
  );
  assert.equal(new Set(partition).size, holed.area);
  assert.equal(partition.length, holed.area);

  assert.equal(holed.lattice(1).length, holed.area);
  assert.deepEqual(holed.lattice(0), []);
});

test("an empty mask answers every question without a special case", () => {
  const empty = createMask([], W, H);
  assert.deepEqual(empty.cells, []);
  assert.deepEqual(empty.bounds, [0, 0, -1, -1]);
  assert.equal(empty.area, 0);
  assert.equal(empty.has(0, 0), false);
  assert.equal(empty.indexOf(0, 0), -1);
  assert.equal(empty.depthAt(0, 0), 0);
  assert.deepEqual(empty.interior(1), []);
  assert.deepEqual(empty.border(), []);
  assert.deepEqual(empty.rects(1, 1), []);
  assert.equal(empty.largestRect(), null);
  assert.deepEqual(empty.lattice(2, 1, 1), []);
  assert.deepEqual(empty.within([0, 0, W - 1, H - 1]), []);
  // The inverted bounds make a containment test false without being asked to.
  const [x0, y0, x1, y1] = empty.bounds;
  assert.equal(x0 <= x1 && y0 <= y1, false);
});

test("a mask refuses indices the grid cannot hold, and repeats", () => {
  const mask = createMask([5, 5, 5, -1, W * H, W * H + 3, 1.5, 6], W, H);
  assert.deepEqual(
    mask.cells.map((c) => c.cellIndex),
    [5, 6],
  );
  assert.deepEqual(mask.bounds, [5, 0, 6, 0]);
});
