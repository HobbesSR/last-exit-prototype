import test from "node:test";
import assert from "node:assert/strict";
import {
  createCanvas,
  describeSegment,
  segmentGridIndex,
} from "../src/micro/edit.ts";
import { checkRegionEdit, guardRegionEdit } from "../src/micro/clearance.ts";
import { PASSAGE, centeredSpan } from "../src/micro/scale.ts";
import type { Box, MapParams, Span } from "../src/types.ts";
import type {
  CellRef,
  RegionContext,
  RegionOpening,
  RegionMask,
  ReservedCorridor,
  Rng,
  SegmentRef,
} from "../src/micro/types.ts";

/**
 * `RegionMask` and `Rng` are implemented in sibling modules; these are
 * hand-rolled stubs against the same interfaces so what a test asserts about
 * the canvas is about the canvas.
 */

/** The radii `core.DEFAULT_PARAMS` carries, restated so this test is hermetic. */
const CONTESTANT = 0.55;
const HUNTER = 0.9;

function makeMask(
  width: number,
  height: number,
  list: Array<[number, number]>,
): RegionMask {
  const keys = new Set(list.map(([x, y]) => y * width + x));
  const cells: CellRef[] = [...keys]
    .sort((a, b) => a - b)
    .map((cellIndex) => ({
      cellIndex,
      x: cellIndex % width,
      y: Math.floor(cellIndex / width),
    }));
  const has = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && keys.has(y * width + x);
  const bounds: Box = [
    Math.min(...cells.map((c) => c.x)),
    Math.min(...cells.map((c) => c.y)),
    Math.max(...cells.map((c) => c.x)),
    Math.max(...cells.map((c) => c.y)),
  ];
  const depthAt = (x: number, y: number) => {
    if (!has(x, y)) return 0;
    for (let r = 1; r <= Math.max(width, height); r += 1)
      for (let dy = -r; dy <= r; dy += 1)
        for (let dx = -r; dx <= r; dx += 1)
          if (
            Math.max(Math.abs(dx), Math.abs(dy)) === r &&
            !has(x + dx, y + dy)
          )
            return r;
    return Math.max(width, height);
  };
  const boxFits = (box: Box) => {
    for (let y = box[1]; y <= box[3]; y += 1)
      for (let x = box[0]; x <= box[2]; x += 1) if (!has(x, y)) return false;
    return true;
  };
  const rects = (minWidth: number, minHeight: number): Box[] => {
    const all: Box[] = [];
    for (let y0 = bounds[1]; y0 <= bounds[3]; y0 += 1)
      for (let x0 = bounds[0]; x0 <= bounds[2]; x0 += 1)
        for (let y1 = y0 + minHeight - 1; y1 <= bounds[3]; y1 += 1)
          for (let x1 = x0 + minWidth - 1; x1 <= bounds[2]; x1 += 1) {
            const box: Box = [x0, y0, x1, y1];
            if (boxFits(box)) all.push(box);
          }
    return all.filter(
      (box) =>
        !all.some(
          (other) =>
            other !== box &&
            other[0] <= box[0] &&
            other[1] <= box[1] &&
            other[2] >= box[2] &&
            other[3] >= box[3],
        ),
    );
  };
  return {
    width,
    height,
    cells,
    bounds,
    area: cells.length,
    has,
    indexOf: (x, y) => y * width + x,
    interior: (depth) => cells.filter((c) => depthAt(c.x, c.y) >= depth),
    border: () => cells.filter((c) => depthAt(c.x, c.y) === 1),
    depthAt,
    rects,
    largestRect: (minWidth = 1, minHeight = 1) =>
      rects(minWidth, minHeight).reduce<Box | null>(
        (best, box) =>
          !best ||
          (box[2] - box[0] + 1) * (box[3] - box[1] + 1) >
            (best[2] - best[0] + 1) * (best[3] - best[1] + 1)
            ? box
            : best,
        null,
      ),
    lattice: (step, phaseX = 0, phaseY = 0) =>
      cells.filter(
        (c) =>
          (((c.x - phaseX) % step) + step) % step === 0 &&
          (((c.y - phaseY) % step) + step) % step === 0,
      ),
    within: (box) =>
      cells.filter(
        (c) => c.x >= box[0] && c.y >= box[1] && c.x <= box[2] && c.y <= box[3],
      ),
  };
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A plain LCG behind the named-stream interface; determinism is all we need. */
function makeRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return {
    stream: (name) => makeRng(seed ^ hash(name)),
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) =>
      items.length ? items[Math.floor(next() * items.length)] : undefined,
    shuffle: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
}

/** A stream that hands back a fixed cycle, so a weighted pick is pinned. */
function fixedRng(values: number[]): Rng {
  let at = 0;
  const rng = makeRng(1);
  return {
    ...rng,
    stream: () => fixedRng(values),
    next: () => values[at++ % values.length]!,
  };
}

interface StubOptions {
  width?: number;
  height?: number;
  cells: Array<[number, number]>;
  openings?: Array<Partial<RegionOpening> & SegmentRef>;
  reserved?: Array<[number, number]>;
  budget?: number;
  corridors?: ReservedCorridor[];
  rng?: Rng;
}

function makeContext(options: StubOptions): RegionContext {
  const width = options.width ?? 8,
    height = options.height ?? 8;
  const mask = makeMask(width, height, options.cells);
  const reserved = new Set(
    (options.reserved ?? []).map(([x, y]) => `${x},${y}`),
  );
  const openings: RegionOpening[] = (options.openings ?? []).map((o) => {
    const [a, b] = o.vertical
      ? [
          { x: o.line - 1, y: o.offset },
          { x: o.line, y: o.offset },
        ]
      : [
          { x: o.offset, y: o.line - 1 },
          { x: o.offset, y: o.line },
        ];
    const [inside, outside] = mask.has(a.x, a.y) ? [a, b] : [b, a];
    const ref = (c: { x: number; y: number }): CellRef => ({
      cellIndex: c.y * width + c.x,
      x: c.x,
      y: c.y,
    });
    return {
      vertical: o.vertical,
      line: o.line,
      offset: o.offset,
      inside: o.inside ?? ref(inside),
      outside: o.outside ?? ref(outside),
      width: o.width ?? 1,
      required: o.required ?? false,
    };
  });
  return {
    regionId: "r-stub",
    cellClass: "hut",
    rule: {},
    seed: "stub",
    rng: options.rng ?? makeRng(7),
    mask,
    grid: {
      tileSize: 6,
      tileOf: (x, y) => ({ col: Math.floor(x / 6), row: Math.floor(y / 6) }),
      tileBounds: (col, row) => [col * 6, row * 6, col * 6 + 5, row * 6 + 5],
      onTileBorder: (x, y) => x % 6 === 0 || y % 6 === 0,
      onTileSeam: (ref) => ref.line % 6 === 0,
      snap: (value) => Math.round(value / 6) * 6,
    },
    params: { tileSize: 6 } as MapParams,
    candidates: [],
    budget: options.budget ?? 0,
    isReserved: (x, y) => reserved.has(`${x},${y}`),
    // No macro pass claims standing room in these fixtures.
    isStandingRoom: () => false,
    openings,
    corridors: options.corridors ?? [],
    clearance: { contestant: CONTESTANT, hunter: HUNTER },
    zoneAt: () => ({ tier: 1, bonus: 0, lootChance: 0.04 }),
  };
}

/** A 4 x 4 region at (1,1)-(4,4) in an 8 x 8 grid, with (4,4) held back. */
function smallContext(extra: Partial<StubOptions> = {}): RegionContext {
  const cells: Array<[number, number]> = [];
  for (let y = 1; y <= 4; y += 1)
    for (let x = 1; x <= 4; x += 1) cells.push([x, y]);
  return makeContext({ cells, reserved: [[4, 4]], budget: 2, ...extra });
}

/** A 13 x 13 region at (1,1)-(13,13) in a 15 x 15 grid, open on two sides. */
function wideContext(extra: Partial<StubOptions> = {}): RegionContext {
  const cells: Array<[number, number]> = [];
  for (let y = 1; y <= 13; y += 1)
    for (let x = 1; x <= 13; x += 1) cells.push([x, y]);
  return makeContext({
    width: 15,
    height: 15,
    cells,
    budget: 4,
    // Two segments each side: one segment alone admits no hunter, so a
    // single-segment doorway would make every hunter test vacuous.
    openings: [
      { vertical: true, line: 1, offset: 6 },
      { vertical: true, line: 1, offset: 7 },
      { vertical: true, line: 14, offset: 6 },
      { vertical: true, line: 14, offset: 7 },
    ],
    ...extra,
  });
}

test("a cell edit stops at the mask and at a reserved cell", () => {
  const canvas = createCanvas(smallContext());
  assert.equal(canvas.cell(0, 0, { class: "hut" }), false);
  assert.equal(canvas.rejected, 1);
  assert.equal(canvas.cell(4, 4, { class: "hut" }), false);
  assert.equal(canvas.rejected, 2);
  assert.equal(canvas.cell(1, 1, { class: "hut", height: 2 }), true);
  assert.equal(canvas.rejected, 2);
  const edit = canvas.finish("stub");
  assert.deepEqual(edit.cells, [{ cellIndex: 9, class: "hut", height: 2 }]);
  assert.equal(edit.manifest.rejected, 2);
});

test("a segment needs one of its own two cells", () => {
  const canvas = createCanvas(smallContext());
  // The region owns the segments on its own boundary: that is its perimeter.
  assert.equal(canvas.wall(canvas.edgeOf(1, 1, "W")), true);
  assert.equal(canvas.rejected, 0);
  // Two cells outside the region is reaching into somebody else's interior.
  assert.equal(canvas.wall({ vertical: true, line: 7, offset: 7 }), false);
  assert.equal(canvas.rejected, 1);
  // A reserved cell is not owned either, so its outer edge is out of reach.
  assert.equal(canvas.wall({ vertical: true, line: 5, offset: 4 }), false);
  assert.equal(canvas.rejected, 2);
  assert.equal(canvas.finish("stub").segments.length, 1);
});

test("a vertex needs one of the four cells that meet at it", () => {
  const canvas = createCanvas(smallContext());
  assert.equal(canvas.vertex(1, 1, { height: 1 }), true);
  assert.equal(canvas.vertex(7, 7, { height: 1 }), false);
  assert.equal(canvas.rejected, 1);
  assert.deepEqual(canvas.finish("stub").vertices, [{ x: 1, y: 1, height: 1 }]);
});

test("a required opening may be widened but never narrowed", () => {
  const context = smallContext({
    openings: [
      { vertical: true, line: 1, offset: 2, required: true },
      { vertical: false, line: 1, offset: 3 },
    ],
  });
  const canvas = createCanvas(context);
  const required: SegmentRef = { vertical: true, line: 1, offset: 2 };
  assert.equal(canvas.wall(required), false);
  assert.equal(canvas.aperture(required, 0.5), false);
  assert.equal(canvas.rejected, 2);
  assert.equal(canvas.open(required), true);

  // The optional one narrows, which is allowed and noted: the clearance pass
  // is the judge of whether it still works, not the canvas.
  const optional: SegmentRef = { vertical: false, line: 1, offset: 3 };
  assert.equal(canvas.aperture(optional, 0.5), true);
  const edit = canvas.finish("stub");
  assert.equal(edit.manifest.notes?.narrowed, 1);
  assert.equal(edit.manifest.rejected, 2);
});

test("widening an opening is not a narrowing and is not noted", () => {
  const canvas = createCanvas(
    smallContext({ openings: [{ vertical: true, line: 1, offset: 2 }] }),
  );
  assert.equal(canvas.open({ vertical: true, line: 1, offset: 2 }), true);
  assert.equal(canvas.finish("stub").manifest.notes, undefined);
});

test("a prop stays in the one cell that produced it", () => {
  const canvas = createCanvas(smallContext());
  // Straddling two cells: refused, exactly as validateMap would reject it.
  assert.equal(canvas.prop({ x1: 1.5, y1: 1.5, x2: 2.5, y2: 1.5 }), false);
  assert.equal(canvas.rejected, 1);
  // Reaching a cell boundary counts as leaving.
  assert.equal(canvas.prop({ x1: 1.5, y1: 1.5, x2: 2.0, y2: 1.5 }), false);
  // Inside one cell: kept, and off the lattice.
  assert.equal(canvas.prop({ x1: 1.2, y1: 1.3, x2: 1.8, y2: 1.7 }), true);
  assert.equal(canvas.propInCell(2, 2, 0.6, 0.7), true);
  // A cell the region does not own takes no props at all.
  assert.equal(canvas.prop({ x1: 6.2, y1: 6.2, x2: 6.8, y2: 6.8 }), false);
  assert.equal(canvas.propInCell(4, 4, 0.6, 0.7), false);
  const edit = canvas.finish("stub");
  assert.equal(edit.obstacles.length, 2);
  assert.equal(edit.manifest.obstaclesPlaced, 2);
  assert.equal(canvas.rejected, 4);
});

test("a spawn answers to the mask, the reservation and the budget", () => {
  const context = smallContext({ budget: 2 });
  const canvas = createCanvas(context);
  const at = (x: number, y: number) => y * context.mask.width + x;
  assert.equal(canvas.spawn(at(0, 0), "loot"), false);
  assert.equal(canvas.spawn(at(4, 4), "loot"), false);
  assert.equal(canvas.spawn(at(1, 1), "loot"), true);
  // A slot is claimed once; the second claim is refused rather than merged.
  assert.equal(canvas.spawn(at(1, 1), "charger"), false);
  assert.equal(canvas.spawn(at(2, 1), "loot"), true);
  assert.equal(canvas.spawn(at(3, 1), "loot"), false);
  assert.equal(canvas.rejected, 4);
  const edit = canvas.finish("stub");
  assert.equal(edit.manifest.spawnsPlaced, 2);
  assert.deepEqual(
    edit.spawns.map((s) => s.cellIndex),
    [at(1, 1), at(2, 1)],
  );
});

test("a second declaration on one primitive wins without double counting", () => {
  const canvas = createCanvas(smallContext());
  canvas.cell(1, 1, { class: "a" });
  canvas.cell(1, 1, { class: "b" });
  const ref = canvas.edgeOf(2, 2, "N");
  canvas.wall(ref);
  canvas.open(ref);
  canvas.feature("exit", 2, 2);
  canvas.feature("exit", 2, 2);
  const edit = canvas.finish("stub");
  assert.equal(edit.cells.length, 1);
  assert.equal(edit.cells[0]!.class, "b");
  assert.equal(edit.segments.length, 1);
  assert.deepEqual(edit.segments[0]!.open, [0, 1]);
  assert.equal(edit.features.length, 1);
  assert.equal(canvas.rejected, 0);
});

test("segment addressing matches the repository convention", () => {
  const canvas = createCanvas(smallContext());
  assert.deepEqual(canvas.edgeOf(3, 2, "N"), {
    vertical: false,
    line: 2,
    offset: 3,
  });
  assert.deepEqual(canvas.edgeOf(3, 2, "S"), {
    vertical: false,
    line: 3,
    offset: 3,
  });
  assert.deepEqual(canvas.edgeOf(3, 2, "W"), {
    vertical: true,
    line: 3,
    offset: 2,
  });
  assert.deepEqual(canvas.edgeOf(3, 2, "E"), {
    vertical: true,
    line: 4,
    offset: 2,
  });
  // `between` is the same segment read from either side.
  assert.deepEqual(canvas.between(3, 2, 4, 2), canvas.edgeOf(3, 2, "E"));
  assert.deepEqual(canvas.between(4, 2, 3, 2), canvas.edgeOf(3, 2, "E"));
  assert.deepEqual(canvas.between(3, 2, 3, 3), canvas.edgeOf(3, 2, "S"));
  assert.equal(canvas.between(3, 2, 5, 2), undefined);
  assert.equal(canvas.between(3, 2, 4, 3), undefined);
  assert.equal(describeSegment(canvas.edgeOf(3, 2, "E")), "v:4,2");
});

test("room walls a 5 x 5 outline, punches its door and paints the interior", () => {
  const context = wideContext();
  const canvas = createCanvas(context);
  const box: Box = [2, 2, 6, 6];
  assert.equal(canvas.outline(box).length, 20);

  const result = canvas.room(box, {
    doors: 1,
    doorWidth: PASSAGE.door,
    interiorClass: "hut-floor",
    rng: fixedRng([0]),
  });
  assert.equal(result.placed, true);
  // A door of two segments is two segments wide: one segment cannot be more
  // than fully open, so `PASSAGE.door` is a run.
  assert.equal(result.doors.length, 2);
  const edit = canvas.finish("room");
  assert.equal(edit.segments.length, 20);
  const open = edit.segments.filter((s) => s.open !== null);
  assert.equal(open.length, 2);
  for (const segment of open) assert.deepEqual(segment.open, [0, 1]);
  assert.deepEqual(
    open.map((s) => describeSegment(s.ref)).sort(),
    result.doors.map(describeSegment).sort(),
  );
  assert.equal(edit.segments.filter((s) => s.open === null).length, 18);

  // The 3 x 3 strictly inside the outline is painted, and nothing else.
  assert.equal(edit.cells.length, 9);
  for (const cell of edit.cells) {
    assert.equal(cell.class, "hut-floor");
    const x = cell.cellIndex % context.mask.width,
      y = Math.floor(cell.cellIndex / context.mask.width);
    assert.ok(x >= 3 && x <= 5 && y >= 3 && y <= 5, `painted ${x},${y}`);
  }
  // Every cell of the box is claimed, including the ring.
  for (let y = 2; y <= 6; y += 1)
    for (let x = 2; x <= 6; x += 1) assert.equal(canvas.isClaimed(x, y), true);
  assert.equal(canvas.isClaimed(7, 7), false);
});

test("a window is an aperture nobody passes", () => {
  const canvas = createCanvas(wideContext());
  const result = canvas.room([2, 2, 6, 6], {
    doors: 1,
    windows: 1,
    windowWidth: 0.6,
    rng: fixedRng([0, 0.99]),
  });
  assert.equal(result.placed, true);
  const edit = canvas.finish("room");
  const narrow = edit.segments.filter(
    (s) => s.open !== null && s.open[1] - s.open[0] < 1,
  );
  assert.equal(narrow.length, 1);
  assert.deepEqual(narrow[0]!.open, centeredSpan(0.6));
});

test("room refuses a box that leaves the mask or a door that does not fit", () => {
  const canvas = createCanvas(smallContext());
  // The 4 x 4 region cannot hold a box that runs past it.
  assert.equal(canvas.room([3, 3, 7, 7]).placed, false);
  assert.equal(canvas.rejected, 1);
  // Nor one covering the cell another pass reserved.
  assert.equal(canvas.room([2, 2, 4, 4]).placed, false);
  assert.equal(canvas.rejected, 2);
  // More doors than there are outline segments to put them in.
  assert.equal(canvas.room([1, 1, 3, 3], { doors: 20 }).placed, false);
  assert.equal(canvas.rejected, 3);
  // A door wider than the only side it is allowed to use.
  assert.equal(
    canvas.room([1, 1, 3, 3], { doors: 1, doorWidth: 6, sides: ["N"] }).placed,
    false,
  );
  assert.equal(canvas.rejected, 4);
  // And a refusal declares nothing at all.
  assert.deepEqual(canvas.finish("room").segments, []);
});

test("finish is deterministic and independent of declaration order", () => {
  const declareInOrder = (order: "forward" | "reverse") => {
    const canvas = createCanvas(smallContext({ budget: 3 }));
    const cells: Array<[number, number]> = [
      [1, 1],
      [2, 3],
      [3, 2],
    ];
    const segments: SegmentRef[] = [
      { vertical: true, line: 2, offset: 1 },
      { vertical: false, line: 3, offset: 2 },
      { vertical: true, line: 4, offset: 3 },
    ];
    const spawns = [1 * 8 + 1, 3 * 8 + 2, 2 * 8 + 3];
    const step = <T>(items: T[]) =>
      order === "forward" ? items : [...items].reverse();
    for (const [x, y] of step(cells)) canvas.cell(x, y, { class: "hut" });
    for (const ref of step(segments)) canvas.wall(ref);
    for (const cellIndex of step(spawns)) canvas.spawn(cellIndex, "loot");
    canvas.propInCell(1, 2, 0.5, 0.3);
    return canvas.finish("scatter");
  };
  const first = declareInOrder("forward");
  assert.deepEqual(declareInOrder("forward"), first);
  // Order within a primitive kind is not part of the output.
  assert.deepEqual(declareInOrder("reverse"), first);
  // And the emitted order is ascending grid index.
  const indexes = first.segments.map((s) => segmentGridIndex(8, 8, s.ref));
  assert.deepEqual(
    [...indexes].sort((a, b) => a - b),
    indexes,
  );
  assert.deepEqual(
    first.cells.map((c) => c.cellIndex),
    [9, 19, 26],
  );
  assert.deepEqual(
    first.spawns.map((s) => s.cellIndex),
    [9, 19, 26],
  );
});

test("an untouched region is clear for both bodies", () => {
  const context = wideContext();
  const edit = createCanvas(context).finish("empty");
  for (const radius of [CONTESTANT, HUNTER]) {
    const report = checkRegionEdit(context, edit, radius);
    assert.equal(report.ok, true, report.failures.join("; "));
    assert.equal(report.connected, 4);
  }
});

test("a wall that severs the region is caught, and guarded away", () => {
  const context = wideContext();
  const canvas = createCanvas(context);
  // A full-height divider: contained, legal, and it cuts the region in two.
  for (let y = 1; y <= 13; y += 1)
    assert.equal(canvas.wall({ vertical: true, line: 7, offset: y }), true);
  canvas.spawn(6 * 15 + 3, "loot");
  canvas.propInCell(3, 7, 0.5, 0.4);
  const edit = canvas.finish("divider");
  assert.equal(edit.segments.length, 13);

  const report = checkRegionEdit(context, edit, HUNTER);
  assert.equal(report.ok, false);
  assert.equal(report.connected, 2);
  assert.equal(report.failures.length, 2);
  assert.ok(
    report.failures.every((f) => /is cut off from opening/.test(f)),
    report.failures.join("; "),
  );
  // The message names the opening, so a builder can act on it.
  assert.ok(report.failures.some((f) => f.includes("v:14,6")));

  const guarded = guardRegionEdit(context, edit, HUNTER);
  const after = checkRegionEdit(context, guarded, HUNTER);
  assert.equal(after.ok, true, after.failures.join("; "));
  assert.equal(after.connected, 4);
  // Only walls are dropped, and only as many as it took.
  assert.ok(guarded.segments.length < edit.segments.length);
  assert.ok(guarded.segments.length > 0);
  assert.deepEqual(guarded.obstacles, edit.obstacles);
  assert.deepEqual(guarded.spawns, edit.spawns);
  assert.equal(guarded.manifest.corridorsHonored, true);
  assert.equal(
    guarded.manifest.notes?.guardDropped,
    edit.segments.length - guarded.segments.length,
  );
  // An edit that already passes is handed straight back.
  assert.equal(guardRegionEdit(context, guarded, HUNTER), guarded);
});

test("a squeeze admits a contestant and stops a hunter", () => {
  const context = wideContext();
  const canvas = createCanvas(context);
  const room = canvas.room([4, 4, 8, 8], {
    doors: 1,
    doorWidth: PASSAGE.squeeze,
    sides: ["N"],
    rng: fixedRng([0]),
  });
  assert.equal(room.placed, true);
  assert.equal(canvas.spawn(6 * 15 + 6, "loot"), true);
  const edit = canvas.finish("squeeze");
  // The door is 1.5 segments across: every contestant, no hunter.
  const opened = edit.segments.filter((s) => s.open !== null);
  const width = opened.reduce((sum, s) => sum + (s.open![1] - s.open![0]), 0);
  assert.equal(Math.round(width * 100) / 100, PASSAGE.squeeze);

  const forContestant = checkRegionEdit(context, edit, CONTESTANT);
  assert.equal(forContestant.ok, true, forContestant.failures.join("; "));
  assert.equal(forContestant.connected, 4);

  const forHunter = checkRegionEdit(context, edit, HUNTER);
  assert.equal(forHunter.ok, false);
  // The region itself is still whole; it is the spawn behind the squeeze that
  // no hunter can reach.
  assert.equal(forHunter.connected, 4);
  assert.equal(forHunter.failures.length, 1);
  assert.ok(
    /spawn loot at cell 6,6 cannot be reached/.test(forHunter.failures[0]!),
    forHunter.failures[0],
  );
});

test("a reserved corridor is checked at its own radius", () => {
  const corridor: ReservedCorridor = {
    points: [
      { x: 3.5, y: 7 },
      { x: 10.5, y: 7 },
    ],
    radius: CONTESTANT,
  };
  const context = wideContext({ corridors: [corridor] });
  const clear = createCanvas(context).finish("empty");
  assert.equal(checkRegionEdit(context, clear, CONTESTANT).ok, true);

  const canvas = createCanvas(context);
  for (let y = 1; y <= 13; y += 1)
    canvas.wall({ vertical: true, line: 7, offset: y });
  const severed = checkRegionEdit(
    context,
    canvas.finish("divider"),
    CONTESTANT,
  );
  assert.equal(severed.ok, false);
  assert.ok(
    severed.failures.some((f) => /reserved corridor 0 is severed/.test(f)),
    severed.failures.join("; "),
  );
});

test("a region of one cell cannot fail, and one with no openings is judged on its spawns", () => {
  const single = makeContext({ cells: [[2, 2]], budget: 1 });
  assert.equal(
    checkRegionEdit(single, createCanvas(single).finish("tiny"), HUNTER).ok,
    true,
  );

  // No openings: nothing to be mutually reachable, but a sealed-off spawn is
  // still a builder that stranded its own content.
  const closed = wideContext({ openings: [] });
  const canvas = createCanvas(closed);
  const room = canvas.room([4, 4, 8, 8], { doors: 1, rng: fixedRng([0]) });
  assert.equal(room.placed, true);
  for (const ref of room.doors) canvas.wall(ref);
  assert.equal(canvas.spawn(6 * 15 + 6, "loot"), true);
  const report = checkRegionEdit(closed, canvas.finish("sealed"), CONTESTANT);
  assert.equal(report.ok, false);
  assert.equal(report.connected, 0);
  assert.ok(report.failures.some((f) => /cannot be reached/.test(f)));
});

test("notes are free-form counters surfaced in the manifest", () => {
  const canvas = createCanvas(smallContext());
  canvas.note("benches");
  canvas.note("benches", 4);
  const manifest = canvas.finish("scatter").manifest;
  assert.equal(manifest.generator, "scatter");
  assert.equal(manifest.notes?.benches, 5);
});

/** Type-level assurance that the stubs really do satisfy the interfaces. */
test("the stub context satisfies the published contract", () => {
  const context: RegionContext = wideContext();
  const span: Span = [0, 1];
  assert.equal(context.mask.area, 169);
  assert.deepEqual(context.mask.bounds, [1, 1, 13, 13]);
  assert.equal(context.mask.largestRect(2, 2)?.[0], 1);
  assert.equal(span[1], 1);
});
