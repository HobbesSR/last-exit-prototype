import test from "node:test";
import assert from "node:assert/strict";
import { createCanvas, segmentGridIndex } from "../src/micro/edit.ts";
import {
  checkConformance,
  conformRegionEdit,
  portWidth,
} from "../src/micro/conform.ts";
import {
  PASSAGE,
  admits,
  clearanceFor,
  isSqueeze,
} from "../src/micro/scale.ts";
import type { Box, MapParams, Span } from "../src/types.ts";
import type {
  CellRef,
  PerimeterPort,
  RegionContext,
  RegionEdit,
  RegionMask,
  Rng,
  SegmentEdit,
  SegmentRef,
} from "../src/micro/types.ts";

/**
 * `RegionMask` and `Rng` live in sibling modules; these are hand-rolled stubs
 * against the same interfaces, so what a test asserts about conformance is
 * about conformance. The mask stub is rectangle-only, which every fixture here
 * is, and every fixture is small enough to read as geometry rather than as
 * fixture data.
 */

/** The radii `core.DEFAULT_PARAMS` carries, restated so this test is hermetic. */
const CONTESTANT = 0.55;
const HUNTER = 0.9;

function makeMask(width: number, height: number, box: Box): RegionMask {
  const [x0, y0, x1, y1] = box;
  const cells: CellRef[] = [];
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1)
      cells.push({ cellIndex: y * width + x, x, y });
  const has = (x: number, y: number) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const depthAt = (x: number, y: number) =>
    has(x, y) ? 1 + Math.min(x - x0, y - y0, x1 - x, y1 - y) : 0;
  const rects = (minWidth: number, minHeight: number): Box[] =>
    x1 - x0 + 1 >= minWidth && y1 - y0 + 1 >= minHeight ? [box] : [];
  return {
    width,
    height,
    cells,
    bounds: box,
    area: cells.length,
    has,
    indexOf: (x, y) => y * width + x,
    interior: (depth) => cells.filter((c) => depthAt(c.x, c.y) >= depth),
    border: () => cells.filter((c) => depthAt(c.x, c.y) === 1),
    depthAt,
    rects,
    largestRect: (minWidth = 1, minHeight = 1) =>
      rects(minWidth, minHeight)[0] ?? null,
    lattice: (step, phaseX = 0, phaseY = 0) =>
      cells.filter(
        (c) =>
          (((c.x - phaseX) % step) + step) % step === 0 &&
          (((c.y - phaseY) % step) + step) % step === 0,
      ),
    within: (b) =>
      cells.filter(
        (c) => c.x >= b[0] && c.y >= b[1] && c.x <= b[2] && c.y <= b[3],
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

/** A 13 x 13 region at (1,1)-(13,13) of a 15 x 15 map. */
const GRID = 15;
const REGION: Box = [1, 1, 13, 13];

/**
 * Two segments a side, because one segment alone is one unit across and admits
 * no hunter, which would make every hunter assertion here vacuous.
 */
const WEST: SegmentRef[] = [
  { vertical: true, line: 1, offset: 6 },
  { vertical: true, line: 1, offset: 7 },
];
const EAST: SegmentRef[] = [
  { vertical: true, line: 14, offset: 6 },
  { vertical: true, line: 14, offset: 7 },
];

function makeContext(ports?: PerimeterPort[]): RegionContext {
  const mask = makeMask(GRID, GRID, REGION);
  return {
    regionId: "r-stub",
    cellClass: "hut",
    rule: {},
    seed: "stub",
    rng: makeRng(7),
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
    budget: 4,
    isReserved: () => false,
    // No macro pass claims standing room in these fixtures.
    isStandingRoom: () => false,
    // The plan path states ports; nothing here was discovered after the fact.
    openings: [],
    ...(ports ? { ports } : {}),
    corridors: [],
    clearance: { contestant: CONTESTANT, hunter: HUNTER },
    zoneAt: () => ({ tier: 1, bonus: 0, lootChance: 0.04 }),
  };
}

function port(
  id: string,
  segments: SegmentRef[],
  required: PerimeterPort["required"],
  allowed: PerimeterPort["allowed"],
): PerimeterPort {
  return { id, neighbour: `n-${id}`, segments, required, allowed };
}

function makeEdit(segments: SegmentEdit[] = []): RegionEdit {
  return {
    spawns: [],
    obstacles: [],
    cells: [],
    segments,
    vertices: [],
    features: [],
    manifest: {
      generator: "stub",
      spawnsPlaced: 0,
      obstaclesPlaced: 0,
      corridorsHonored: true,
    },
  };
}

/** The declared span of one segment in an edit, or undefined when undeclared. */
function spanIn(edit: RegionEdit, ref: SegmentRef): Span | undefined {
  const want = segmentGridIndex(GRID, GRID, ref);
  return edit.segments.find(
    (segment) => segmentGridIndex(GRID, GRID, segment.ref) === want,
  )?.open;
}

test("a port's width is its widest continuous opening, end to end", () => {
  const run: SegmentRef[] = [
    { vertical: true, line: 1, offset: 5 },
    { vertical: true, line: 1, offset: 6 },
    { vertical: true, line: 1, offset: 7 },
  ];
  const measure = (spans: Span[], count = spans.length) => {
    const context = makeContext();
    const edit = makeEdit(spans.map((open, i) => ({ ref: run[i]!, open })));
    return portWidth(
      context,
      edit,
      port("p", run.slice(0, count), "none", "hunter"),
    );
  };

  // Two whole segments in a row are one opening two units across.
  assert.equal(
    measure(
      [
        [0, 1],
        [0, 1],
      ],
      2,
    ),
    2,
  );
  // Half of one and half of the next meet in the middle: still one opening.
  assert.equal(
    measure(
      [
        [0.5, 1],
        [0, 0.5],
      ],
      2,
    ),
    1,
  );
  // A barrier between two whole segments is two openings, not one.
  assert.equal(measure([[0, 1], null, [0, 1]], 3), 1);
  // A port with no segments is no opening at all.
  assert.equal(
    portWidth(makeContext(), makeEdit(), port("p", [], "none", "hunter")),
    0,
  );
});

test("a walled port carrying a hunter floor is re-opened to a door", () => {
  const ports = [
    port("west", WEST, "hunter", "hunter"),
    port("east", EAST, "hunter", "hunter"),
  ];
  const context = makeContext(ports);
  const canvas = createCanvas(context);
  // A builder that decided it wanted a solid west wall.
  for (const ref of WEST) assert.equal(canvas.wall(ref), true);
  const edit = canvas.finish("stub");

  const before = checkConformance(context, edit);
  assert.equal(before.ok, false);
  assert.equal(before.ports.find((p) => p.portId === "west")?.width, 0);
  assert.equal(
    before.ports.find((p) => p.portId === "west")?.problem,
    "below-floor",
  );
  assert.equal(before.ports.find((p) => p.portId === "east")?.ok, true);

  const conformed = conformRegionEdit(context, edit);
  const width = portWidth(context, conformed, ports[0]!);
  assert.ok(
    width >= PASSAGE.door,
    `west port opens ${width}, wanted at least ${PASSAGE.door}`,
  );
  assert.equal(checkConformance(context, conformed).ok, true);
});

test("a port left wide open under a contestant ceiling is narrowed to a squeeze", () => {
  const ports = [
    port("west", WEST, "contestant", "contestant"),
    port("east", EAST, "contestant", "hunter"),
  ];
  const context = makeContext(ports);
  // Nothing declared: the lattice a region is handed starts open, so the
  // builder has left the whole side passable to anything.
  const edit = makeEdit();
  const loose = checkConformance(context, edit);
  assert.equal(loose.ok, false);
  assert.equal(
    loose.ports.find((p) => p.portId === "west")?.problem,
    "above-ceiling",
  );

  const conformed = conformRegionEdit(context, edit);
  const width = portWidth(context, conformed, ports[0]!);
  assert.equal(isSqueeze(width), true);
  // A contestant fits and a hunter does not: the point of a squeeze.
  assert.equal(admits(width, clearanceFor("contestant")), true);
  assert.equal(admits(width, clearanceFor("hunter")), false);
  assert.equal(admits(width, 2 * HUNTER), false);
  // The ceiling is a property of the port, not of every port.
  assert.equal(portWidth(context, conformed, ports[1]!), 2);
  assert.equal(checkConformance(context, conformed).ok, true);
});

test("a port whose ceiling is none is sealed", () => {
  const ports = [
    port("west", WEST, "none", "none"),
    port("east", EAST, "none", "hunter"),
  ];
  const context = makeContext(ports);
  const conformed = conformRegionEdit(context, makeEdit());
  assert.equal(portWidth(context, conformed, ports[0]!), 0);
  for (const ref of WEST) assert.equal(spanIn(conformed, ref), null);
  assert.equal(checkConformance(context, conformed).ok, true);
});

test("a wall severing two required ports is dropped, and the fixed port is not", () => {
  const ports = [
    port("west", WEST, "contestant", "contestant"),
    port("east", EAST, "contestant", "hunter"),
  ];
  const context = makeContext(ports);
  const canvas = createCanvas(context);
  // A solid partition down the middle of the region, and a west side the
  // builder walled shut on its way past.
  for (let offset = 1; offset <= 13; offset += 1)
    assert.equal(canvas.wall({ vertical: true, line: 7, offset }), true);
  for (const ref of WEST) assert.equal(canvas.wall(ref), true);
  const edit = canvas.finish("stub");

  const before = checkConformance(context, edit);
  assert.equal(before.ok, false);
  assert.ok(
    before.failures.some((line) => line.includes("cut off inside the region")),
  );

  const conformed = conformRegionEdit(context, edit);
  assert.equal(checkConformance(context, conformed).ok, true);
  // The gate this pass just cut is a partial span, so it was a candidate for
  // dropping on width alone: it survived because a port segment is protected.
  for (const ref of WEST) {
    const span = spanIn(conformed, ref);
    assert.ok(span, "the west port gate was dropped");
    assert.ok(span![1] - span![0] > 0);
  }
  // The partition lost only as many segments as it took to reconnect.
  const partition = conformed.segments.filter(
    (segment) => segment.ref.vertical && segment.ref.line === 7,
  );
  assert.ok(partition.length > 0 && partition.length < 13);
  assert.equal(conformed.manifest.notes?.conformDropped, 13 - partition.length);
});

test("spawns, props and cell edits come through byte for byte", () => {
  const ports = [
    port("west", WEST, "hunter", "hunter"),
    port("east", EAST, "contestant", "contestant"),
  ];
  const context = makeContext(ports);
  const canvas = createCanvas(context);
  for (const ref of WEST) canvas.wall(ref);
  canvas.cell(4, 4, { class: "rubble", height: 1 });
  canvas.vertex(4, 4, { height: 2 });
  canvas.propInCell(5, 5, 0.6, 0);
  canvas.spawn(4 * GRID + 4, "loot");
  canvas.feature("exit", 6, 6);
  const edit = canvas.finish("stub");
  const conformed = conformRegionEdit(context, edit);

  assert.notDeepEqual(conformed.segments, edit.segments);
  assert.deepEqual(conformed.spawns, edit.spawns);
  assert.deepEqual(conformed.obstacles, edit.obstacles);
  assert.deepEqual(conformed.cells, edit.cells);
  assert.deepEqual(conformed.vertices, edit.vertices);
  assert.deepEqual(conformed.features, edit.features);
});

test("conformance is deterministic and independent of declaration order", () => {
  const ports = [
    port("west", WEST, "contestant", "contestant"),
    port("east", EAST, "contestant", "hunter"),
  ];
  const context = makeContext(ports);
  const canvas = createCanvas(context);
  for (let offset = 1; offset <= 13; offset += 1)
    canvas.wall({ vertical: true, line: 7, offset });
  for (const ref of WEST) canvas.wall(ref);
  const edit = canvas.finish("stub");

  const once = conformRegionEdit(context, edit);
  const twice = conformRegionEdit(context, edit);
  assert.deepEqual(once, twice);

  const shuffled = {
    ...edit,
    segments: makeRng(3).shuffle(edit.segments),
  };
  assert.notDeepEqual(shuffled.segments, edit.segments);
  assert.deepEqual(conformRegionEdit(context, shuffled), once);
});

test("no plan is no contract: absent ports is a clean no-op", () => {
  const context = makeContext();
  assert.equal(context.ports, undefined);
  const canvas = createCanvas(context);
  for (const ref of WEST) canvas.wall(ref);
  const edit = canvas.finish("stub");

  assert.deepEqual(checkConformance(context, edit), {
    ok: true,
    ports: [],
    failures: [],
  });
  // Unchanged by identity: the legacy path shares these builders and must not
  // be handed a rebuilt edit for a plan it never had.
  assert.equal(conformRegionEdit(context, edit), edit);
});
