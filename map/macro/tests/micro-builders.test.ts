/**
 * The catalogue of region builders.
 *
 * Every builder is held to the same contract -- determinism, containment,
 * reserved cells, required openings, an honest manifest -- and then to whatever
 * its own design claims on top of that. The shared half is table driven because
 * a new builder should inherit the whole checklist by being added to one array.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, cellsCrossed } from "../src/core.ts";
import { SIDES } from "../src/primitives.ts";
import { generateRegion } from "../src/regions.ts";
import { createMask } from "../src/micro/mask.ts";
import { createRng } from "../src/micro/rng.ts";
import { segmentCells } from "../src/micro/edit.ts";
import { checkRegionEdit } from "../src/micro/clearance.ts";
import { PASSAGE, isSqueeze } from "../src/micro/scale.ts";
import {
  builderFor,
  getBuilder,
  listBuilders,
  registerBuilder,
  resetCatalogue,
  setFallbackBuilder,
} from "../src/micro/catalogue.ts";
import {
  FALLBACK_BUILDER_ID,
  MICRO_BUILDERS,
  boxesApart,
  planClusters,
  planPillars,
  registerMicroBuilders,
  scatterInput,
  siteRooms,
} from "../src/micro/index.ts";
import type {
  Box,
  CellClass,
  RegionCandidate,
  Side,
  Span,
} from "../src/types.ts";
import type {
  GridAxis,
  RegionContext,
  RegionEdit,
  RegionOpening,
  SegmentRef,
} from "../src/micro/types.ts";

const EPS = 1e-9;
const W = 48;
const H = 36;
const TILE = DEFAULT_PARAMS.tileSize;
/** A tile-aligned 24 x 18 region: big enough for every builder in the table. */
const REGION: Box = [6, 6, 29, 23];
/** Cells another pass owns. Nothing a builder states may land on these. */
const RESERVED: Array<[number, number]> = [
  [12, 12],
  [13, 12],
];

const segKey = (ref: SegmentRef): string =>
  `${ref.vertical ? "v" : "h"}:${ref.line}:${ref.offset}`;

/** The tile lattice a builder may align to. Six-cell tiles, as every map has. */
function makeGrid(): GridAxis {
  return {
    tileSize: TILE,
    tileOf: (x, y) => ({
      col: Math.floor(x / TILE),
      row: Math.floor(y / TILE),
    }),
    tileBounds: (col, row) => [
      col * TILE,
      row * TILE,
      col * TILE + TILE - 1,
      row * TILE + TILE - 1,
    ],
    onTileBorder: (x, y) => x % TILE === 0 || y % TILE === 0,
    onTileSeam: (ref) => ref.line % TILE === 0,
    snap: (value) => Math.round(value / TILE) * TILE,
  };
}

function rectCells(box: Box): number[] {
  const out: number[] = [];
  for (let y = box[1]; y <= box[3]; y += 1)
    for (let x = box[0]; x <= box[2]; x += 1) out.push(y * W + x);
  return out;
}

/** The three ways out of the test region: two segments each, one of them required. */
function makeOpenings(): RegionOpening[] {
  const cell = (x: number, y: number) => ({ cellIndex: y * W + x, x, y });
  const openings: RegionOpening[] = [];
  for (const offset of [8, 9])
    openings.push({
      vertical: true,
      line: 6,
      offset,
      inside: cell(6, offset),
      outside: cell(5, offset),
      width: 1,
      // The west run is the one no route may lose, so no builder may narrow it.
      required: offset === 8,
    });
  for (const offset of [12, 13])
    openings.push({
      vertical: true,
      line: 30,
      offset,
      inside: cell(29, offset),
      outside: cell(30, offset),
      width: 1,
      required: false,
    });
  for (const offset of [20, 21])
    openings.push({
      vertical: false,
      line: 6,
      offset,
      inside: cell(offset, 6),
      outside: cell(offset, 5),
      width: 1,
      required: false,
    });
  return openings;
}

interface ContextOptions {
  seed?: string;
  cells?: number[];
  rule?: CellClass;
  reserved?: Array<[number, number]>;
  openings?: RegionOpening[];
  budget?: number;
  lootChance?: number;
}

function makeContext(options: ContextOptions = {}): RegionContext {
  const seed = options.seed ?? "micro-builders";
  const cells = options.cells ?? rectCells(REGION);
  const reserved = new Set(
    (options.reserved ?? RESERVED).map(([x, y]) => `${x},${y}`),
  );
  const mask = createMask(cells, W, H);
  const isReserved = (x: number, y: number) => reserved.has(`${x},${y}`);
  const zoneAt = (x: number, _y: number) => {
    const tier = Math.min(5, Math.max(1, Math.floor(x / 12) + 1));
    return {
      tier,
      bonus: 0,
      lootChance:
        options.lootChance ??
        DEFAULT_PARAMS.lootChance + DEFAULT_PARAMS.lootTierStep * (tier - 1),
    };
  };
  const candidates: RegionCandidate[] = mask
    .lattice(2, 1, 1)
    .filter((cell) => !isReserved(cell.x, cell.y))
    .map((cell) => ({
      cellIndex: cell.cellIndex,
      x: cell.x,
      y: cell.y,
      lootChance: zoneAt(cell.x, cell.y).lootChance,
    }));
  return {
    regionId: "r-test",
    cellClass: "yard",
    rule: options.rule ?? {},
    seed,
    rng: createRng(seed),
    mask,
    grid: makeGrid(),
    params: { ...DEFAULT_PARAMS },
    candidates,
    budget: options.budget ?? candidates.length,
    isReserved,
    // No macro pass claims standing room in these fixtures.
    isStandingRoom: () => false,
    openings: options.openings ?? makeOpenings(),
    corridors: [],
    clearance: {
      contestant: DEFAULT_PARAMS.contestantRadius,
      hunter: DEFAULT_PARAMS.hunterRadius,
    },
    zoneAt,
  };
}

/** Spans the edit states, by segment key. Anything absent is open by default. */
function spansOf(edit: RegionEdit): Map<string, Span> {
  return new Map(edit.segments.map((s) => [segKey(s.ref), s.open]));
}

/**
 * The widths of the continuous open runs along a line of collinear segments.
 *
 * A door two segments wide is two spans that meet exactly at the shared vertex,
 * so contiguity has to be measured rather than assumed: a segment open in its
 * middle does not continue into its neighbour, however open that neighbour is.
 */
function openRuns(
  spans: Map<string, Span>,
  refs: SegmentRef[],
  absent: Span = [0, 1],
): number[] {
  const widths: number[] = [];
  let current = 0;
  let joins = false;
  const flush = () => {
    if (current > EPS) widths.push(current);
    current = 0;
  };
  for (const ref of refs) {
    const key = segKey(ref);
    const span = spans.has(key) ? spans.get(key)! : absent;
    if (!span || span[1] - span[0] <= EPS) {
      flush();
      joins = false;
      continue;
    }
    if (joins && span[0] <= EPS) current += span[1] - span[0];
    else {
      flush();
      current = span[1] - span[0];
    }
    joins = span[1] >= 1 - EPS;
    if (!joins) flush();
  }
  flush();
  return widths;
}

/** The segments along one side of an inclusive cell box, in offset order. */
function sideRefs(box: Box, side: Side): SegmentRef[] {
  const [x0, y0, x1, y1] = box;
  const refs: SegmentRef[] = [];
  if (side === "N" || side === "S")
    for (let x = x0; x <= x1; x += 1)
      refs.push({
        vertical: false,
        line: side === "N" ? y0 : y1 + 1,
        offset: x,
      });
  else
    for (let y = y0; y <= y1; y += 1)
      refs.push({
        vertical: true,
        line: side === "W" ? x0 : x1 + 1,
        offset: y,
      });
  return refs;
}

const cellOf = (index: number) => ({ x: index % W, y: Math.floor(index / W) });

// ---------------------------------------------------------------------------
// The contract every builder is held to.
// ---------------------------------------------------------------------------

for (const builder of MICRO_BUILDERS) {
  test(`${builder.id}: two builds of one context are identical`, () => {
    const context = makeContext();
    assert.deepEqual(builder.build(context), builder.build(context));
    // A different seed is a different region, or the seed is not being read.
    const other = makeContext({ seed: "micro-builders-2" });
    const a = JSON.stringify(builder.build(context));
    const b = JSON.stringify(builder.build(other));
    if (builder.id !== "loot-scatter" || a !== b)
      assert.notEqual(a, b, "the seed changed nothing");
  });

  test(`${builder.id}: everything it states lands inside the region`, () => {
    const context = makeContext();
    const edit = builder.build(context);
    const { mask, isReserved } = context;

    for (const cell of edit.cells) {
      const { x, y } = cellOf(cell.cellIndex);
      assert.ok(mask.has(x, y), `cell ${x},${y} is outside the region`);
      assert.ok(!isReserved(x, y), `cell ${x},${y} is reserved`);
    }
    for (const spawn of edit.spawns) {
      const { x, y } = cellOf(spawn.cellIndex);
      assert.ok(mask.has(x, y), `spawn ${x},${y} is outside the region`);
      assert.ok(!isReserved(x, y), `spawn ${x},${y} is reserved`);
    }
    for (const feature of edit.features) {
      assert.ok(mask.has(feature.x, feature.y));
      assert.ok(!isReserved(feature.x, feature.y));
    }
    // A prop lives in exactly one cell of its own region: the invariant
    // tests/micro.test.ts pins for the legacy pass, restated per builder.
    for (const prop of edit.obstacles) {
      const crossed = cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2);
      assert.equal(crossed.length, 1, "a prop left its cell");
      const [x, y] = crossed[0]!;
      assert.ok(mask.has(x!, y!), `prop at ${x},${y} is outside the region`);
      assert.ok(!isReserved(x!, y!), `prop at ${x},${y} is reserved`);
    }
    // A region owns the segments on its own boundary and nothing past them.
    for (const segment of edit.segments) {
      const [a, b] = segmentCells(segment.ref);
      assert.ok(
        mask.has(a.x, a.y) || mask.has(b.x, b.y),
        `segment ${segKey(segment.ref)} touches no cell of the region`,
      );
    }
    for (const vertex of edit.vertices)
      assert.ok(
        [
          [vertex.x - 1, vertex.y - 1],
          [vertex.x, vertex.y - 1],
          [vertex.x - 1, vertex.y],
          [vertex.x, vertex.y],
        ].some(([x, y]) => mask.has(x!, y!)),
      );
  });

  test(`${builder.id}: a required opening survives whatever it builds`, () => {
    const context = makeContext();
    const edit = builder.build(context);
    const spans = spansOf(edit);
    for (const opening of context.openings) {
      if (!opening.required) continue;
      const span = spans.get(segKey(opening));
      if (span === undefined) continue;
      assert.notEqual(span, null, "a required opening was walled");
      assert.ok(
        span![1] - span![0] >= Math.min(1, opening.width) - EPS,
        "a required opening was narrowed",
      );
    }
  });

  test(`${builder.id}: the manifest says what the arrays say`, () => {
    const context = makeContext();
    const edit = builder.build(context);
    assert.equal(edit.manifest.generator, builder.id);
    assert.equal(edit.manifest.spawnsPlaced, edit.spawns.length);
    assert.equal(edit.manifest.obstaclesPlaced, edit.obstacles.length);
    assert.ok(edit.spawns.length <= context.budget);
    assert.equal(typeof edit.manifest.corridorsHonored, "boolean");
  });

  test(`${builder.id}: it leaves the region usable for a contestant`, () => {
    const context = makeContext();
    const edit = builder.build(context);
    const report = checkRegionEdit(context, edit, context.clearance.contestant);
    assert.equal(report.ok, true, report.failures.slice(0, 3).join("; "));
  });
}

// ---------------------------------------------------------------------------
// What each builder claims for itself.
// ---------------------------------------------------------------------------

test("loot-scatter is the legacy pass, not a second copy of it", () => {
  const context = makeContext();
  const edit = MICRO_BUILDERS.find((b) => b.id === "loot-scatter")!.build(
    context,
  );
  // The two sets are restated here rather than borrowed from the builder, so
  // the adaptation is what is under test: a slot only has to miss the cells
  // another pass owns, while a prop also has to keep a cell of margin from
  // STANDING room, because it reaches into the corner it shares with it.
  //
  // The margin is around standing room and not around every reserved cell. A
  // street is reserved because a body walks along it, and a prop beside a
  // street is wanted -- it is what stops the street being a clear shot. Only
  // ground a body has to stand on, like a tile anchor, costs its neighbours.
  const spawnable = (x: number, y: number) => !context.isReserved(x, y);
  const buildable = (x: number, y: number) => {
    if (context.isReserved(x, y)) return false;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1)
        if (context.isStandingRoom(x + dx, y + dy)) return false;
    return !context.openings.some(
      (opening) =>
        Math.abs(opening.inside.x - x) + Math.abs(opening.inside.y - y) <= 1,
    );
  };
  const expected = generateRegion(
    {
      seed: context.seed,
      cellClass: context.cellClass,
      candidates: context.candidates.filter((c) => spawnable(c.x, c.y)),
      budget: context.budget,
      area: context.mask.cells
        .filter((c) => spawnable(c.x, c.y) && buildable(c.x, c.y))
        .map(({ cellIndex, x, y }) => ({ cellIndex, x, y })),
    },
    {},
  );
  assert.deepEqual(edit.spawns, expected.spawns);
  assert.deepEqual(edit.obstacles, expected.obstacles);
  assert.equal(
    scatterInput(context).area?.length,
    context.mask.cells.filter((c) => spawnable(c.x, c.y) && buildable(c.x, c.y))
      .length,
  );
  assert.equal(edit.cells.length, 0);
  assert.equal(edit.segments.length, 0);
});

test("loot-scatter carries the clutter rule through to the props", () => {
  const context = makeContext({ rule: { clutterChance: 1, clutterSize: 0.4 } });
  const edit = MICRO_BUILDERS.find((b) => b.id === "loot-scatter")!.build(
    context,
  );
  assert.ok(edit.obstacles.length > 0, "a clutter rule of 1 placed nothing");
  // The catalogue keys are not the legacy rule's business and must not reach it.
  const withCatalogueKeys = makeContext({
    rule: {
      clutterChance: 1,
      generator: "loot-scatter",
      generatorParams: { density: 0.5 },
    },
  });
  assert.doesNotThrow(() =>
    MICRO_BUILDERS.find((b) => b.id === "loot-scatter")!.build(
      withCatalogueKeys,
    ),
  );
});

test("pillar-hall keeps every aisle at least PASSAGE.wide", () => {
  const context = makeContext();
  const plan = planPillars(context);
  const edit = MICRO_BUILDERS.find((b) => b.id === "pillar-hall")!.build(
    context,
  );
  const solid = edit.cells.filter((cell) => cell.class === "solid");
  assert.ok(solid.length > 0, "a 24 x 18 region got no pillars");
  assert.equal(
    solid.length,
    edit.cells.length,
    "pillar-hall stated non-solid cells",
  );
  assert.ok(plan.aisle >= PASSAGE.wide);

  // Two solid cells facing each other across an aisle are `aisle` free cells
  // apart, so their coordinates differ by `aisle + 1`. Anything between one
  // block width and that is an alley the design does not allow.
  const points = solid.map((cell) => cellOf(cell.cellIndex));
  const clear = (delta: number) =>
    delta < plan.blockSize || delta >= plan.aisle + 1;
  for (const a of points)
    for (const b of points) {
      if (a.y === b.y && b.x > a.x)
        assert.ok(
          clear(b.x - a.x),
          `aisle of ${b.x - a.x - 1} cells at y=${a.y}`,
        );
      if (a.x === b.x && b.y > a.y)
        assert.ok(
          clear(b.y - a.y),
          `aisle of ${b.y - a.y - 1} cells at x=${a.x}`,
        );
    }
});

test("pillar-hall offsets successive rows by half a period", () => {
  const context = makeContext();
  const plan = planPillars(context);
  const axis = plan.staggerRows
    ? { of: (box: Box) => box[1], along: (box: Box) => box[0] }
    : { of: (box: Box) => box[0], along: (box: Box) => box[1] };
  const bands = new Map<number, number>();
  for (const box of plan.blocks) {
    const residue =
      ((axis.along(box) % plan.period) + plan.period) % plan.period;
    const seen = bands.get(axis.of(box));
    if (seen !== undefined)
      assert.equal(seen, residue, "a band is not a lattice");
    bands.set(axis.of(box), residue);
  }
  const ordered = [...bands.entries()].sort((a, b) => a[0] - b[0]);
  assert.ok(ordered.length >= 3, "too few bands to stagger");
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]![0] - ordered[i - 1]![0] !== plan.period) continue;
    const step =
      (((ordered[i]![1] - ordered[i - 1]![1]) % plan.period) + plan.period) %
      plan.period;
    assert.equal(step, plan.stride % plan.period, "rows are not offset");
  }
  // The point of the offset: three bands of the lattice already cover every
  // residue, so no aisle runs the length of the region for a shot to travel.
  const covered = new Set<number>();
  for (let j = 0; j < Math.min(3, ordered.length); j += 1)
    for (let k = 0; k < plan.blockSize; k += 1)
      covered.add((j * plan.stride + k) % plan.period);
  assert.equal(covered.size, plan.period, "a lane survives every band");
});

test("compound rooms are separated by a street, not an alley", () => {
  const context = makeContext();
  const rooms = siteRooms(context);
  assert.ok(rooms.length >= 2, `expected several rooms, got ${rooms.length}`);
  // Buildable ground, not `mask.interior(2)`. Keeping a building two cells off
  // the block border is cosmetic, and on a real block -- which streets and tile
  // anchors punch a hole in every tile -- depth-2 collapses to a handful of
  // scattered cells and no room fits anywhere. What a building actually owes is
  // that every cell of it is in the block and belongs to no other pass.
  const interior = new Set(
    context.mask.cells
      .filter((cell) => !context.isReserved(cell.x, cell.y))
      .map((cell) => cell.cellIndex),
  );
  for (const room of rooms) {
    const w = room.box[2] - room.box[0] + 1;
    const h = room.box[3] - room.box[1] + 1;
    assert.ok(w >= 3 && w <= 6 && h >= 3 && h <= 6, `room is ${w} x ${h}`);
    for (let y = room.box[1]; y <= room.box[3]; y += 1)
      for (let x = room.box[0]; x <= room.box[2]; x += 1)
        assert.ok(
          interior.has(y * W + x),
          `room cell ${x},${y} is not buildable`,
        );
  }
  for (const a of rooms)
    for (const b of rooms)
      if (a !== b)
        assert.ok(
          boxesApart(a.box, b.box, PASSAGE.wide),
          `rooms ${a.box} and ${b.box} are closer than a street`,
        );
});

test("compound rooms have the doors they claim, at the widths they claim", () => {
  const context = makeContext();
  const rooms = siteRooms(context);
  const edit = MICRO_BUILDERS.find((b) => b.id === "compound")!.build(context);
  const spans = spansOf(edit);
  const notes = edit.manifest.notes ?? {};

  let doors = 0;
  let squeezes = 0;
  let through = 0;
  for (const room of rooms) {
    const perSide = SIDES.map((side) => ({
      side,
      runs: openRuns(spans, sideRefs(room.box, side), null),
    }));
    const wide = perSide.filter((entry) =>
      entry.runs.some((width) => width >= PASSAGE.door - EPS),
    );
    const narrow = perSide.flatMap((entry) =>
      entry.runs.filter((width) => isSqueeze(width)),
    );
    assert.ok(wide.length >= 1, `room ${room.box} has no door`);
    doors += wide.reduce(
      (total, entry) =>
        total + entry.runs.filter((w) => w >= PASSAGE.door - EPS).length,
      0,
    );
    squeezes += narrow.length;
    if (wide.length >= 2) through += 1;
  }
  assert.equal(doors, notes.doors, "doors measured disagree with the manifest");
  assert.equal(squeezes, notes.squeezeEntrances ?? 0);
  assert.equal(through, notes.throughRooms ?? 0);
  // A squeeze is the asymmetry this catalogue exists to express, so the
  // measured width has to sit in the band, not merely be narrower than a door.
  for (const room of rooms)
    for (const side of SIDES)
      for (const width of openRuns(spans, sideRefs(room.box, side), null))
        assert.ok(
          width >= PASSAGE.squeeze - EPS || width < PASSAGE.squeeze,
          `run of ${width} on ${side}`,
        );
});

test("courtyard leaves two or three gates and one of them is a squeeze", () => {
  const context = makeContext();
  const edit = MICRO_BUILDERS.find((b) => b.id === "courtyard")!.build(context);
  const notes = edit.manifest.notes ?? {};
  const spans = spansOf(edit);

  assert.ok(
    (notes.gates ?? 0) >= 2 && (notes.gates ?? 0) <= 3,
    `expected two or three gates, got ${notes.gates}`,
  );
  assert.ok((notes.squeezeGates ?? 0) >= 1, "no contestant-only gate");
  assert.equal(notes.setPieces, 1);
  assert.ok((edit.features ?? []).some((f) => f.kind === "set-piece"));

  // Measured on the border itself: a gate is a run of open span in a wall that
  // is otherwise closed, and the widths are the design's own numbers.
  const widths: number[] = [];
  for (const side of SIDES)
    widths.push(...openRuns(spans, sideRefs(REGION, side), null));
  const gates = widths.filter((width) => width >= PASSAGE.squeeze - EPS);
  assert.equal(gates.length, notes.gates);
  assert.ok(
    gates.some((width) => isSqueeze(width)),
    `no gate in the squeeze band: ${widths.join(", ")}`,
  );
  assert.ok(
    gates.some((width) => width >= PASSAGE.door - EPS),
    `no gate a hunter may use: ${widths.join(", ")}`,
  );
  // The wall is a wall: most of the border carries a barrier.
  assert.ok((notes.borderWalls ?? 0) > 60, `only ${notes.borderWalls} walls`);
});

test("rubble leaves gaps a contestant threads and a hunter may not", () => {
  const context = makeContext();
  const edit = MICRO_BUILDERS.find((b) => b.id === "rubble")!.build(context);
  assert.ok(edit.obstacles.length > 20, "broken ground with no debris");

  // The extent of the debris in each occupied cell, then the gap between two
  // occupied cells that face each other along an axis.
  const extents = new Map<string, Box>();
  for (const prop of edit.obstacles) {
    const [x, y] = cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2)[0]!;
    const key = `${x},${y}`;
    const box = extents.get(key) ?? [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    extents.set(key, [
      Math.min(box[0], prop.x1, prop.x2),
      Math.min(box[1], prop.y1, prop.y2),
      Math.max(box[2], prop.x1, prop.x2),
      Math.max(box[3], prop.y1, prop.y2),
    ]);
  }
  let measured = 0;
  for (const [key, box] of extents) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    for (const [dx, dy] of [
      [2, 0],
      [0, 2],
    ] as const) {
      const other = extents.get(`${x + dx},${y + dy}`);
      if (!other) continue;
      const gap = dx ? other[0] - box[2] : other[1] - box[3];
      assert.ok(
        gap >= PASSAGE.squeeze - EPS,
        `gap of ${gap} at ${key} is too tight for a contestant`,
      );
      assert.ok(
        gap <= PASSAGE.door + EPS,
        `gap of ${gap} at ${key} is wide enough for a hunter`,
      );
      measured += 1;
    }
  }
  assert.ok(measured > 20, `only ${measured} gaps were measurable`);
  assert.equal(edit.manifest.notes?.hunterHostile, 1);
  // It is guarded at the contestant radius on purpose, so the contestant check
  // is the one that has to pass; the hunter one is allowed to fail.
  assert.equal(
    checkRegionEdit(context, edit, context.clearance.contestant).ok,
    true,
  );
});

test("open-field keeps wide aisles between clusters and closes no loop", () => {
  const context = makeContext();
  const edit = MICRO_BUILDERS.find((b) => b.id === "open-field")!.build(
    context,
  );
  const notes = edit.manifest.notes ?? {};
  assert.ok((notes.clusters ?? 0) >= 3, `only ${notes.clusters} clusters`);

  // Cells carrying cover: a prop lives in one, and a wall divides two.
  const occupied = new Set<string>();
  for (const prop of edit.obstacles) {
    const [x, y] = cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2)[0]!;
    occupied.add(`${x},${y}`);
  }
  for (const segment of edit.segments) {
    if (segment.open !== null) continue;
    for (const cell of segmentCells(segment.ref))
      if (context.mask.has(cell.x, cell.y)) occupied.add(`${cell.x},${cell.y}`);
  }

  // Clusters are the lattice the builder planned, not blobs recovered from the
  // output: a cluster's own props are scattered over nine cells and need not
  // touch each other, so proximity is the wrong way to tell two apart.
  const plan = planClusters(context);
  const points = [...occupied].map((key) => {
    const [x, y] = key.split(",").map(Number);
    return { x: x!, y: y! };
  });
  const owner = new Map<string, number>();
  for (const point of points) {
    const near = plan.centres.findIndex(
      (centre) =>
        Math.max(Math.abs(centre.x - point.x), Math.abs(centre.y - point.y)) <=
        plan.extent,
    );
    assert.notEqual(
      near,
      -1,
      `cover at ${point.x},${point.y} belongs to no cluster`,
    );
    owner.set(`${point.x},${point.y}`, near);
  }
  assert.ok(new Set(owner.values()).size >= 2, "expected several clusters");

  // Three free cells is a clear span of PASSAGE.wide, so cover belonging to two
  // different clusters has to stand at least four cells apart.
  for (const a of points)
    for (const b of points) {
      if (owner.get(`${a.x},${a.y}`) === owner.get(`${b.x},${b.y}`)) continue;
      const distance = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      assert.ok(
        distance >= PASSAGE.wide + 1,
        `clusters at ${a.x},${a.y} and ${b.x},${b.y} leave only ${distance - 1} free cells`,
      );
    }

  // No stub closes a loop: the walls form a forest over the lattice vertices.
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    parent.set(key, parent.get(key) ?? key);
    while (parent.get(key) !== key) key = parent.get(key)!;
    return key;
  };
  for (const segment of edit.segments) {
    if (segment.open !== null) continue;
    const { vertical, line, offset } = segment.ref;
    const ends = vertical
      ? [`${line},${offset}`, `${line},${offset + 1}`]
      : [`${offset},${line}`, `${offset + 1},${line}`];
    const roots = ends.map(find);
    assert.notEqual(roots[0], roots[1], "a stub closed a loop");
    parent.set(roots[0]!, roots[1]!);
  }
});

test("open-field spends its loot budget behind cover", () => {
  // Every slot worth taking and room for five of them: the ones chosen must be
  // the ones something stands in front of.
  const context = makeContext({ budget: 5, lootChance: 1 });
  const edit = MICRO_BUILDERS.find((b) => b.id === "open-field")!.build(
    context,
  );
  assert.equal(edit.spawns.length, 5);
  const cover = new Set<string>();
  for (const prop of edit.obstacles) {
    const [x, y] = cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2)[0]!;
    cover.add(`${x},${y}`);
  }
  for (const segment of edit.segments) {
    if (segment.open !== null) continue;
    for (const cell of segmentCells(segment.ref))
      cover.add(`${cell.x},${cell.y}`);
  }
  // Two cells, not one: the cell pressed against a prop is usually not
  // standing room, so "behind cover" means within reach of it rather than
  // wedged into it.
  for (const spawn of edit.spawns) {
    const { x, y } = cellOf(spawn.cellIndex);
    let behind = false;
    for (let dy = -2; dy <= 2; dy += 1)
      for (let dx = -2; dx <= 2; dx += 1)
        if (cover.has(`${x + dx},${y + dy}`)) behind = true;
    assert.ok(behind, `slot at ${x},${y} is in the open`);
  }
});

/**
 * The failure this pins: a builder that places props can strand its own loot
 * slot behind them, and the clearance guard cannot repair that -- it drops
 * walls, and a spawn is not a wall -- so it drops every barrier the builder
 * stated instead. One bad slot used to cost a courtyard all 82 of its walls.
 */
test("no builder strands what it placed, on any seed or region shape", () => {
  const ell = [...rectCells([6, 6, 17, 23]), ...rectCells([18, 6, 29, 13])];
  const shapes: Array<[string, number[]]> = [
    ["rectangle", rectCells(REGION)],
    ["ell", ell],
    ["small", rectCells([6, 6, 11, 11])],
  ];
  for (const [name, cells] of shapes)
    for (const seed of ["a", "b", "c", "d", "e", "f"])
      for (const builder of MICRO_BUILDERS) {
        // Only the west run: it is the one way out that every shape here has,
        // and an opening whose cell the region does not contain is a broken
        // context rather than a builder under test.
        const context = makeContext({
          seed: `${name}-${seed}`,
          cells,
          openings: makeOpenings().slice(0, 2),
        });
        if (context.mask.area < builder.minArea) continue;
        const edit = builder.build(context);
        // Rubble is guarded at the contestant radius on purpose and is the one
        // builder allowed to shut a hunter out of the region entirely.
        const radius =
          builder.id === "rubble"
            ? context.clearance.contestant
            : context.clearance.hunter;
        const report = checkRegionEdit(context, edit, radius);
        assert.equal(
          report.ok,
          true,
          `${builder.id} on ${name}/${seed}: ${report.failures[0]}`,
        );
        assert.equal(
          edit.manifest.corridorsHonored,
          true,
          `${builder.id} on ${name}/${seed} gave up its geometry`,
        );
        for (const cell of edit.cells)
          assert.ok(
            context.mask.has(
              cellOf(cell.cellIndex).x,
              cellOf(cell.cellIndex).y,
            ),
          );
        for (const prop of edit.obstacles)
          assert.equal(
            cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2).length,
            1,
          );
      }
});

// ---------------------------------------------------------------------------
// The catalogue itself.
// ---------------------------------------------------------------------------

test("the catalogue answers with what a class rule asked for", () => {
  assert.equal(builderFor({ generator: "courtyard" }, 400).id, "courtyard");
  assert.equal(builderFor({ generator: "rubble" }, 400).id, "rubble");
  // Unknown names and unnamed classes both fall back rather than failing.
  assert.equal(
    builderFor({ generator: "no-such-builder" }, 400).id,
    FALLBACK_BUILDER_ID,
  );
  assert.equal(builderFor({}, 400).id, FALLBACK_BUILDER_ID);
  // And so does a region too small for what it asked for.
  assert.equal(
    builderFor({ generator: "compound" }, 12).id,
    FALLBACK_BUILDER_ID,
  );
  assert.equal(builderFor({ generator: "rubble" }, 12).id, "rubble");
  assert.equal(
    listBuilders()
      .map((b) => b.id)
      .join(","),
    [...MICRO_BUILDERS]
      .map((b) => b.id)
      .sort()
      .join(","),
  );
});

test("registration is idempotent and survives a reset", () => {
  const before = listBuilders().length;
  registerMicroBuilders();
  assert.equal(listBuilders().length, before);
  assert.doesNotThrow(() => registerMicroBuilders());

  resetCatalogue();
  assert.equal(listBuilders().length, 0);
  assert.equal(getBuilder("compound"), undefined);
  assert.throws(() => builderFor({ generator: "compound" }, 400));
  assert.throws(() => setFallbackBuilder("compound"));

  registerMicroBuilders();
  assert.equal(listBuilders().length, before);
  assert.equal(builderFor({ generator: "compound" }, 400).id, "compound");

  // A later registration under a known id replaces rather than appends.
  const stub = {
    id: "compound",
    description: "stub",
    minArea: 1,
    build: () => {
      throw new Error("not called");
    },
  };
  registerBuilder(stub);
  assert.equal(getBuilder("compound"), stub);
  registerMicroBuilders();
  assert.notEqual(getBuilder("compound"), stub);
  assert.equal(listBuilders().length, before);
});

test("every builder in the catalogue declares what the contract needs", () => {
  for (const builder of MICRO_BUILDERS) {
    assert.ok(builder.id.length > 0);
    assert.ok(
      builder.description.length > 10,
      `${builder.id} has no description`,
    );
    assert.ok(Number.isInteger(builder.minArea) && builder.minArea >= 1);
    assert.equal(typeof builder.build, "function");
  }
  assert.equal(
    new Set(MICRO_BUILDERS.map((b) => b.id)).size,
    MICRO_BUILDERS.length,
    "two builders share an id",
  );
  assert.equal(
    MICRO_BUILDERS.find((b) => b.id === FALLBACK_BUILDER_ID)?.minArea,
    1,
    "the fallback must take any area at all",
  );
});
