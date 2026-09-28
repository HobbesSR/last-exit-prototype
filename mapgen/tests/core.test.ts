import test from "node:test";
import assert from "node:assert/strict";
import {
  OUTSIDE_CLASS,
  generateMap,
  validateLibrary,
  validateMap,
  findPath,
  canOccupy,
  gridViews,
  cellIndexAt,
  segmentIndexAt,
  DEFAULT_LIBRARY,
} from "../src/core.ts";
import { SOLID_CLASS } from "../src/primitives.ts";
import { batch, summarizeMetrics } from "../tools/shared.mts";

test("generation is deterministic and serializable", () => {
  const a = generateMap("alpha"),
    b = generateMap("alpha");
  assert.deepEqual(a, b);
  assert.doesNotThrow(() => JSON.stringify(a));
  assert.equal(validateMap(a).valid, true);
});
test("game mode keeps its calibrated dimensions and required set-piece recipe", () => {
  assert.throws(
    () => generateMap("game-small", { zoneWidth: 2, zoneHeight: 1 }),
    /game mode requires 12 x 6 tile zones/,
  );

  const incomplete = structuredClone(DEFAULT_LIBRARY);
  incomplete.setPieces = incomplete.setPieces.filter(
    (piece) => piece.category !== "enormous",
  );
  assert.throws(
    () => generateMap("missing-enormous", {}, incomplete),
    /game mode library requires start, end, at least 3 enormous, medium, and small set pieces/,
  );

  const game = generateMap("game-recipe");
  assert.equal(game.params.mode, "game");
  const categoryFor = new Map(
    DEFAULT_LIBRARY.setPieces.map((piece) => [piece.id, piece.category]),
  );
  const placed = new Map<string, Set<string>>();
  for (const tile of game.tiles) {
    if (!tile.setPieceId) continue;
    const category = categoryFor.get(tile.setPieceId);
    if (!category) continue;
    let ids = placed.get(category);
    if (!ids) {
      ids = new Set();
      placed.set(category, ids);
    }
    ids.add(tile.setPieceId);
  }
  assert.ok((placed.get("start")?.size ?? 0) >= 1);
  assert.ok((placed.get("end")?.size ?? 0) >= 1);
  assert.ok((placed.get("enormous")?.size ?? 0) >= 3);
  assert.ok((placed.get("medium")?.size ?? 0) >= 1);
  assert.ok((placed.get("small")?.size ?? 0) >= 1);
});
test("playground mode allows a small map with the shipped library", () => {
  const map = generateMap("playground-small", {
    mode: "playground",
    zoneWidth: 2,
    zoneHeight: 1,
  });
  assert.equal(map.params.mode, "playground");
  assert.equal(map.validation.valid, true, map.validation.errors.join("; "));
});
test("several zone sizes and seeds keep both classes connected", () => {
  for (const seed of ["a", "b", "c"])
    for (const [zoneWidth, zoneHeight] of [
      [1, 1],
      [3, 2],
      [5, 3],
    ]) {
      const m = generateMap(seed, { mode: "playground", zoneWidth, zoneHeight });
      assert.equal(m.tiles.length, 13 * zoneWidth! * zoneHeight!);
      assert.equal(m.validation.valid, true);
      const s = m.features.find((f) => f.kind === "spawn")!;
      for (const e of m.features.filter((f) => f.kind === "exit")) {
        assert.ok(findPath(m, s.tileId, e.tileId, "contestant").length);
        assert.ok(findPath(m, s.tileId, e.tileId, "hunter").length);
      }
    }
});
// Waits on perimeter segment records (#33).
test.todo("a squeeze is authored geometry, measured back off the seam", () => {
  // Nothing in generation makes a squeeze. A design states a 1.5-cell aperture
  // on its own perimeter, and the seam beside it reports what is actually there.
  const library = structuredClone(DEFAULT_LIBRARY);
  library.setPieces = [];
  library.tileSets = [];
  library.tiles = [
    {
      // A 1.5-cell aperture centred on the side, stated segment by segment.
      id: "narrow",
      defaultCellClass: "open",
      orientations: [0],
      edges: {
        N: ["wall", "wall", [0.25, 1], [0, 0.75], "wall", "wall"],
        S: ["wall", "wall", [0.25, 1], [0, 0.75], "wall", "wall"],
      },
    },
    { id: "field", defaultCellClass: "open", orientations: [0] },
  ] as unknown as typeof library.tiles;
  const m = generateMap("squeeze", { mode: "playground", zoneWidth: 2, zoneHeight: 1 }, library);
  assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
  const e = m.edges.find((x) => x.kind === "squeeze");
  assert.ok(e, "the authored aperture is reported as a squeeze");
  assert.equal(e!.width, 1.5);
  const a = m.tiles.find((t) => t.id === e!.a)!,
    b = m.tiles.find((t) => t.id === e!.b)!;
  const x = (a.x + b.x) / 2 + 3,
    y = (a.y + b.y) / 2 + 3;
  assert.equal(canOccupy(m, x, y, 0.55), true);
  assert.equal(canOccupy(m, x, y, 0.9), false);
  // The label follows the measurement; it is not something anyone assigned.
  assert.ok(
    m.edges.every((edge) => edge.width > 0),
    "a seam with no opening produces no edge at all",
  );
});

test("generation imposes no topology: seams are exactly what the tiles declare", () => {
  // An open field must stay an open field. Every seam between two deferring
  // designs is fully clear, and no tile boundary acquires a wall of its own.
  const library = structuredClone(DEFAULT_LIBRARY);
  library.setPieces = [];
  library.tileSets = [];
  library.tiles = [
    { id: "field", defaultCellClass: "open", orientations: [0] },
  ] as unknown as typeof library.tiles;
  const m = generateMap("open-field", { mode: "playground", zoneWidth: 3, zoneHeight: 2 }, library);
  assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
  assert.equal(m.walls.length, 20, "an unstated tile boundary carries no wall");
  assert.equal(m.metrics.sealedSeams, 0);
  assert.ok(m.edges.every((e) => e.width === 6 && e.kind === "wide"));
  assert.equal(m.metrics.squeezes, 0);
  // Every neighbouring pair is reported, so nothing planned the graph down.
  const neighbours = m.tiles.reduce((total, t) => {
    const at = (x: number, y: number) =>
      m.tiles.some((o) => o.x === x && o.y === y);
    return total + (at(t.x + 6, t.y) ? 1 : 0) + (at(t.x, t.y + 6) ? 1 : 0);
  }, 0);
  assert.equal(m.edges.length, neighbours);
});

test("tuning metrics are read off the finished geometry, not initialised and left", () => {
  const only = (tile: object) => {
    const library = structuredClone(DEFAULT_LIBRARY);
    library.setPieces = [];
    library.tileSets = [];
    library.tiles = [tile] as unknown as typeof library.tiles;
    return library;
  };
  const params = { mode: "playground" as const, zoneWidth: 3, zoneHeight: 2 };
  const field = only({ id: "field", defaultCellClass: "open", orientations: [0] });
  // One authored wall per tile, clear of the anchor and of every seam.
  const barrier = only({
    id: "barrier",
    defaultCellClass: "open",
    orientations: [0],
    walls: [{ x1: 1, y1: 1, x2: 5, y2: 1 }],
  });
  const open = generateMap("metrics-open", params, field);
  const walled = generateMap("metrics-barrier", params, barrier);
  for (const m of [open, walled]) {
    assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
    assert.ok(Number.isFinite(m.metrics.contestantDistance) && m.metrics.contestantDistance > 0);
    assert.ok(Number.isFinite(m.metrics.hunterDistance) && m.metrics.hunterDistance > 0);
    assert.ok(m.metrics.detourRatio >= 1, "a route is never shorter than the direct distance");
    assert.equal(m.metrics.largestRegion, Math.max(...m.regions.map((r) => r.cells.length)));
    assert.equal(m.metrics.solidFraction, 0);
  }
  assert.equal(open.metrics.interiorWalls, 0);
  assert.equal(walled.metrics.interiorWalls, walled.metrics.tileCount);

  // No route reads as no route. Zero is what an adjacent exit looks like.
  const baffle = only({
    id: "baffle",
    defaultCellClass: "open",
    orientations: [0],
    walls: [{ x1: 1, y1: 0, x2: 1, y2: 5 }, { x1: 5, y1: 1, x2: 5, y2: 6 }],
  });
  const sealed = generateMap("metrics-baffle", params, baffle);
  assert.equal(sealed.validation.valid, false);
  const exits = sealed.features.filter((f) => f.kind === "exit").length;
  assert.equal(sealed.metrics.unroutedExits, exits);
  // Every route metric says unavailable the same way; none decays to NaN.
  for (const name of [
    "contestantDistance",
    "hunterDistance",
    "detourRatio",
    "exitCostSpread",
    "hunterToContestantRatio",
  ])
    assert.equal(sealed.metrics[name], Infinity, name);
  for (const m of [open, walled]) assert.equal(m.metrics.unroutedExits, 0);

  // And the batch report carries the measured values, not placeholders.
  const report = batch("metrics-batch", 2, params, barrier);
  assert.equal(report.metrics.interiorWalls!.min, walled.metrics.tileCount);
  assert.equal(report.metrics.contestantDistance!.samples, 2);
  assert.equal(report.metrics.contestantDistance!.unavailable, 0);
});

test("a batch distribution says how many maps it describes", () => {
  // The tile graph can miss a route the lattice proves, so a valid map may
  // report Infinity. The summary must count it rather than drop it silently,
  // and must not let a NaN into the statistics.
  const summary = summarizeMetrics([
    { contestantDistance: 60, exitCostSpread: 1 },
    { contestantDistance: Infinity, exitCostSpread: NaN },
    { contestantDistance: 90, exitCostSpread: undefined },
  ]);
  assert.deepEqual(summary.contestantDistance, {
    samples: 2,
    unavailable: 1,
    min: 60,
    max: 90,
    mean: 75,
    p50: 60,
    p95: 90,
  });
  assert.deepEqual(summary.exitCostSpread, {
    samples: 1,
    unavailable: 1,
    min: 1,
    max: 1,
    mean: 1,
    p50: 1,
    p95: 1,
  });
  // A metric no map could measure has no statistics at all, not zeros.
  const none = summarizeMetrics([{ hunterDistance: Infinity }]).hunterDistance;
  assert.equal(none!.samples, 0);
  assert.equal(none!.unavailable, 1);
  assert.equal(none!.min, null);
  assert.equal(none!.mean, null);
});

// Waits on perimeter segment records (#33).
test.todo(
  "any is the deferring value: it states nothing and adopts anything",
  () => {
    // "any" is not a value a seam can carry, it is the absence of one. A design
    // that defers claims nothing, so the design beside it is free to state a wall
    // and the seam carries that wall — whichever of the two was placed first.
    const library = structuredClone(DEFAULT_LIBRARY);
    library.setPieces = [];
    library.tileSets = [];
    library.tiles = [
      { id: "defers", defaultCellClass: "open", orientations: [0] },
      {
        id: "walled-west",
        defaultCellClass: "open",
        orientations: [0],
        edges: { W: ["wall", "wall", "wall", "wall", "wall", "wall"] },
      },
    ] as unknown as typeof library.tiles;
    const m = generateMap(
      "any-adopts",
      { mode: "playground", zoneWidth: 3, zoneHeight: 2 },
      library,
    );
    assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
    assert.ok(
      m.tiles.some((t) => t.templateId === "walled-west"),
      "a stated wall is placeable beside a design that only defers",
    );
    assert.ok(
      m.metrics.sealedSeams! > 0,
      "the seam beside a deferring design carries the wall the other one states",
    );
    // And the wall is really there, on the west side of every such placement.
    const views = gridViews(m);
    for (const t of m.tiles.filter((x) => x.templateId === "walled-west"))
      for (let i = 0; i < 6; i++)
        assert.equal(
          views.segmentOpen(segmentIndexAt(m, true, t.x, t.y + i)),
          null,
          `${t.id} states a wall along its west side`,
        );
    // Two deferring designs state nothing between them, so the seam is clear.
    const open = structuredClone(library);
    open.tiles = [open.tiles[0]!];
    const field = generateMap("any-any", { mode: "playground", zoneWidth: 3, zoneHeight: 2 }, open);
    assert.equal(field.metrics.sealedSeams, 0);
    assert.equal(field.walls.length, 20);
  },
);

// Waits on perimeter segment records (#33).
test.todo("a design walled on every side is never used as fill", () => {
  // The segment editor makes walling a whole perimeter a two-click gesture, and
  // nothing imposes a seam any more, so such a design would be an island
  // wherever it landed. It is refused the way a sealed interior is refused.
  const boxed = {
    id: "boxed",
    defaultCellClass: "open",

    orientations: [0],
    edges: {
      N: ["wall", "wall", "wall", "wall", "wall", "wall"],
      E: ["wall", "wall", "wall", "wall", "wall", "wall"],
      S: ["wall", "wall", "wall", "wall", "wall", "wall"],
      W: ["wall", "wall", "wall", "wall", "wall", "wall"],
    },
  };
  const beside = structuredClone(DEFAULT_LIBRARY);
  beside.tiles.push(boxed as unknown as (typeof beside.tiles)[number]);
  const m = generateMap("boxed-fill", { mode: "playground", zoneWidth: 3, zoneHeight: 2 }, beside);
  assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
  assert.equal(
    m.tiles.filter((t) => t.templateId === "boxed").length,
    0,
    "an island design is not fill",
  );

  // Even as the librarys only fallback, it is passed over rather than placed.
  const asFallback = structuredClone(DEFAULT_LIBRARY);
  asFallback.tiles[0]!.edges = {
    N: ["wall", "wall", "wall", "wall", "wall", "wall"],
    E: ["wall", "wall", "wall", "wall", "wall", "wall"],
    S: ["wall", "wall", "wall", "wall", "wall", "wall"],
    W: ["wall", "wall", "wall", "wall", "wall", "wall"],
  };
  const still = generateMap(
    "boxed-fallback",
    { mode: "playground", zoneWidth: 3, zoneHeight: 2 },
    asFallback,
  );
  assert.equal(
    still.validation.valid,
    true,
    still.validation.errors.join("; "),
  );
  assert.equal(still.tiles.filter((t) => t.templateId === "street").length, 0);

  // A library with nothing else to fall back on fails explicitly, naming why.
  const only = structuredClone(DEFAULT_LIBRARY);
  only.setPieces = [];
  only.tileSets = [];
  only.tiles = [boxed as unknown as (typeof only.tiles)[number]];
  assert.throws(
    () => generateMap("boxed-only", { mode: "playground", zoneWidth: 2, zoneHeight: 1 }, only),
    /walled on every side|no generic fallback/,
  );
});

test("every tile stays reachable and the run can be walked", () => {
  // The only connectivity the generator still owes. Checked over the geometry
  // the tiles produced, for both bodies, rather than over a planned graph.
  for (const seed of ["reach-1", "reach-2", "reach-3"]) {
    const m = generateMap(seed, { mode: "playground", zoneWidth: 3, zoneHeight: 2 });
    assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
    const spawn = m.features.find((f) => f.kind === "spawn")!;
    const hunterSpawn = m.features.find((f) => f.kind === "hunter-spawn")!;
    for (const exit of m.features.filter((f) => f.kind === "exit")) {
      assert.ok(
        findPath(m, spawn.tileId, exit.tileId, "contestant").length,
        `${seed}: contestant route to ${exit.id}`,
      );
      assert.ok(
        findPath(m, hunterSpawn.tileId, exit.tileId, "hunter").length,
        `${seed}: hunter route to ${exit.id}`,
      );
    }
    for (const t of m.tiles)
      assert.ok(
        findPath(m, spawn.tileId, t.id, "hunter").length,
        `${seed}: hunter reaches ${t.id}`,
      );
  }
});
test("library rejects invalid references", () => {
  const bad = structuredClone(DEFAULT_LIBRARY);
  bad.tileSets[0].members.push("missing");
  assert.equal(validateLibrary(bad).valid, false);
  assert.throws(() => generateMap("bad", {}, bad));
});
test("validator rejects malformed and mutated map data without throwing", () => {
  for (const value of [null, {}, { tiles: 42 }] as unknown[])
    assert.equal(validateMap(value).valid, false);
  const m = generateMap("mutation");
  m.walls.push({ x1: 20, y1: 0, x2: 20, y2: m.height });
  assert.equal(validateMap(m).valid, false);
});

test("library validation handles malformed nested input", () => {
  for (const value of [
    null,
    {},
    { version: 1, tiles: 42 },
    { ...DEFAULT_LIBRARY, tiles: [null] },
    { ...DEFAULT_LIBRARY, tileSets: [{ id: "broken", members: 4 }] },
    { ...DEFAULT_LIBRARY, setPieces: [null] },
  ] as unknown[])
    assert.equal(validateLibrary(value).valid, false);
});

test("nonintersecting collinear geometry does not block routes", () => {
  const m = generateMap("collinear", { mode: "playground", zoneWidth: 2, zoneHeight: 1 });
  m.walls.push({ x1: -20, y1: 15, x2: -10, y2: 15 });
  assert.equal(validateMap(m).valid, true);
});

test("loot density rises with tier, and is a property of the zone", () => {
  const m = generateMap("loot-gradient");
  const views = gridViews(m);
  // Loot per offered slot, per tier. Density is what the zone sets; raw counts
  // would only measure how much open area each tier happens to have.
  const slots = new Map<number, { offered: number; loot: number }>();
  for (const zone of m.zones) {
    const bucket = slots.get(zone.tier) ?? { offered: 0, loot: 0 };
    for (let y = zone.cells[1]; y <= zone.cells[3]; y++)
      for (let x = zone.cells[0]; x <= zone.cells[2]; x++) {
        if (x % 2 !== 1 || y % 2 !== 1) continue;
        const i = cellIndexAt(m, x, y);
        if (i < 0 || views.cellClass(i) === OUTSIDE_CLASS || false) continue;
        bucket.offered += 1;
        if (views.spawns.has(i)) bucket.loot += 1;
      }
    slots.set(zone.tier, bucket);
  }
  const density = [1, 2, 3, 4, 5].map((tier) => {
    const bucket = slots.get(tier)!;
    assert.ok(bucket.offered > 0, `tier ${tier} offered no slots`);
    return bucket.loot / bucket.offered;
  });
  for (let i = 1; i < density.length; i++)
    assert.ok(
      density[i]! > density[i - 1]!,
      `tier ${i + 1} (${density[i]}) should be richer than tier ${i} (${density[i - 1]})`,
    );
  // The zone is where the number lives, and the map agrees with it.
  for (const zone of m.zones)
    assert.equal(
      zone.lootChance,
      m.params.lootChance + (zone.tier - 1) * m.params.lootTierStep,
    );
});

test("region rules and manifests use real reserved cell slots", () => {
  const library = structuredClone(DEFAULT_LIBRARY);
  // Loot density is a zone parameter, so it is silenced at the source.
  const m = generateMap("no-loot", { lootChance: 0, lootTierStep: 0 }, library);
  assert.equal(m.metrics.lootCount, 0);
  assert.ok(m.regions.every((r) => r.manifest.spawnsPlaced === 0));
  m.regions[0]!.manifest.spawnsPlaced = 1;
  assert.equal(validateMap(m).valid, false);
});

test("five distinct exit locations can be generated", () => {
  const m = generateMap("five", { exitCount: 5 });
  assert.equal(
    new Set(m.features.filter((f) => f.kind === "exit").map((f) => f.tileId))
      .size,
    5,
  );
  assert.equal(m.validation.valid, true);
});

test("every primitive carries metadata, implicitly or explicitly", () => {
  const m = generateMap("primitives");
  const { width, height } = m.grid;
  // Grids cover each primitive set exactly once.
  assert.equal(m.grid.cells.class.count, width * height);
  // Vertices are stored by exception, so a flat map states none at all.
  assert.deepEqual(m.grid.vertices, []);
  assert.equal(
    m.grid.segments.open.count,
    (width + 1) * height + (height + 1) * width,
  );
  // The palettes are what make that affordable: a handful of enumerated values.
  assert.ok(m.grid.segments.open.palette.length < 16);
  assert.ok(m.grid.cells.class.palette.length < 32);
  assert.ok(
    m.grid.segments.open.runs.length / 2 < m.grid.segments.open.count / 4,
    "run-length coding should collapse the segment grid",
  );
  // Every declared aperture is exactly as open as the seam says.
  const views = gridViews(m);
  for (const e of m.edges.slice(0, 20)) {
    const a = m.tiles.find((t) => t.id === e.a)!,
      b = m.tiles.find((t) => t.id === e.b)!;
    const vertical = a.y === b.y;
    const line = vertical ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    const base = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
    let open = 0;
    for (let i = 0; i < 6; i++) {
      const index = vertical
        ? (base + i) * (width + 1) + line
        : (width + 1) * height + line * width + base + i;
      const span = views.segmentOpen(index);
      open += span ? span[1] - span[0] : 0;
    }
    assert.equal(Math.round(open * 100) / 100, e.width);
  }
});

test("regions aggregate cells across tile seams, not whole tiles", () => {
  const m = generateMap("regions");
  const regionOf = new Map<number, string>();
  for (const r of m.regions) for (const i of r.cells) regionOf.set(i, r.id);

  const views = gridViews(m);
  const W = m.grid.width;

  // A region that is not a union of whole 6x6 blocks.
  const nonRectangular = m.regions.find((r) => {
    if (r.cells.length < 4) return false;
    const xs = r.cells.map((i) => i % W),
      ys = r.cells.map((i) => Math.floor(i / W));
    const w = Math.max(...xs) - Math.min(...xs) + 1,
      h = Math.max(...ys) - Math.min(...ys) + 1;
    return w * h !== r.cells.length;
  });
  assert.ok(nonRectangular, "expected a nonrectangular region");

  // A single tile contributing cells to more than one region.
  const split = m.tiles.find((t) => {
    const ids = new Set<string>();
    for (let dy = 0; dy < 6; dy++)
      for (let dx = 0; dx < 6; dx++)
        ids.add(regionOf.get(cellIndexAt(m, t.x + dx, t.y + dy))!);
    return ids.size > 1;
  });
  assert.ok(split, "expected a tile spanning several regions");

  // A region crossing a seam between two tiles.
  const crossing = m.regions.find(
    (r) => new Set(r.cells.map((i) => Math.floor((i % W) / 6))).size > 1,
  );
  assert.ok(crossing, "expected a region spanning tiles");

  // The partition covers every cell a tile laid down, and nothing stands in
  // material a micro builder laid.
  const covered = new Set(m.regions.flatMap((r) => r.cells));
  for (let i = 0; i < m.grid.width * m.grid.height; i++) {
    if (views.cellClass(i) === OUTSIDE_CLASS) continue;
    assert.ok(covered.has(i), `cell ${i} belongs to no region`);
  }
  for (const spawn of m.grid.cells.spawns)
    assert.notEqual(views.cellClass(spawn.cell), SOLID_CLASS);
});

test("uniform tiles remain ordinary content regardless of omitted or explicit any ports", () => {
  const library = structuredClone(DEFAULT_LIBRARY);
  library.setPieces = [];
  library.tileSets = [];
  library.tiles = [
    {
      id: "field",
      defaultCellClass: "yard",
      orientations: [0],
      ports: {
        N: ["any", "any", "any", "any", "any", "any"],
        E: ["any", "any", "any", "any", "any", "any"],
        S: ["any", "any", "any", "any", "any", "any"],
        W: "any",
      },
    },
  ];
  library.cellClasses = { ...library.cellClasses, yard: {} };
  const params = { mode: "playground" as const, zoneWidth: 2, zoneHeight: 1 };
  const explicit = generateMap("uniform-content", params, library);
  assert.equal(explicit.validation.valid, true);
  assert.ok(explicit.tiles.every((tile) => tile.templateId === "field"));
  delete library.tiles[0]!.ports;
  const omitted = generateMap("uniform-content", params, library);
  // The two libraries are different text, so the maps name different ones.
  assert.notEqual(omitted.layout!.library, explicit.layout!.library);
  omitted.layout!.library = explicit.layout!.library;
  assert.deepEqual(omitted, explicit);
});

test("a malformed library fails once, not once per attempt", (t) => {
  // A tile list with a hole once threw the same TypeError inside every one of
  // the fifty sampling attempts before generation gave up.
  const warn = t.mock.method(console, "warn", () => {});
  const library = structuredClone(DEFAULT_LIBRARY);
  library.tiles = [
    undefined as unknown as (typeof library.tiles)[number],
    ...library.tiles,
  ];
  assert.throws(
    () => generateMap("malformed", {}, library),
    /invalid library: malformed tile/,
  );
  assert.equal(warn.mock.callCount(), 0);
});

// V2 places it and returns an invalid map (#34).
test.todo("a template that seals its own interior is never placed", () => {
  const sealed = {
    id: "sealed",
    defaultCellClass: "court",

    orientations: [0] as const,
    ports: {
      N: ["any", "any", "any", "any", "any", "any"],
      E: ["any", "any", "any", "any", "any", "any"],
      S: ["any", "any", "any", "any", "any", "any"],
      W: "any",
    },
    // A ring on the margin: every seam opens onto a one-cell strip that no
    // body fits through, and nothing inside is reachable from outside.
    walls: [
      { x1: 1, y1: 1, x2: 5, y2: 1 },
      { x1: 1, y1: 5, x2: 5, y2: 5 },
      { x1: 1, y1: 1, x2: 1, y2: 5 },
      { x1: 5, y1: 1, x2: 5, y2: 5 },
    ],
  };
  const library = structuredClone(DEFAULT_LIBRARY);
  library.tiles = [
    library.tiles.find((t) => t.id === "street")!,
    sealed as unknown as (typeof library.tiles)[number],
  ];
  library.tileSets = [{ id: "all", members: ["street", "sealed"] }];
  library.setPieces = [];
  library.cellClasses = { ...library.cellClasses, court: {} };
  const m = generateMap("sealed", { mode: "playground", zoneWidth: 2, zoneHeight: 1 }, library);
  assert.equal(m.validation.valid, true);
  assert.equal(
    m.tiles.filter((t) => t.templateId === "sealed").length,
    0,
    "a sealed interior cannot honour any seam contract",
  );
});

test("nav anchors are real standing room and are validated", () => {
  const m = generateMap("anchors");
  for (const t of m.tiles) {
    assert.ok(canOccupy(m, t.anchor.x, t.anchor.y, m.params.contestantRadius));
    assert.ok(t.anchor.x > t.x && t.anchor.x < t.x + 6);
    assert.ok(t.anchor.y > t.y && t.anchor.y < t.y + 6);
  }
  // Templates with a blocked centre move their anchor off it.
  assert.ok(
    m.tiles.some((t) => t.anchor.x !== t.x + 3 || t.anchor.y !== t.y + 3),
    "expected at least one displaced anchor",
  );
  const moved = generateMap("anchors");
  moved.tiles[0]!.anchor = { x: moved.tiles[0]!.x, y: moved.tiles[0]!.y };
  assert.equal(validateMap(moved).valid, false);
});

test("validation reads the geometry, not the seam widths", () => {
  // A seam stays as wide as the tiles left it while a wall just inside one of
  // them severs the space. Reachability is a flood of the proven lattice, so
  // the added geometry is what decides, not the measured opening beside it.
  const m = generateMap("blocked-interior");
  const spawn = m.features.find((f) => f.kind === "spawn")!;
  const victim = m.tiles.find((t) => t.id !== spawn.tileId)!;
  const widths = m.edges
    .filter((e) => e.a === victim.id || e.b === victim.id)
    .map((e) => e.width);
  m.walls.push(
    { x1: victim.x, y1: victim.y, x2: victim.x + 6, y2: victim.y },
    { x1: victim.x, y1: victim.y + 6, x2: victim.x + 6, y2: victim.y + 6 },
    { x1: victim.x, y1: victim.y, x2: victim.x, y2: victim.y + 6 },
    { x1: victim.x + 6, y1: victim.y, x2: victim.x + 6, y2: victim.y + 6 },
  );
  const result = validateMap(m);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /cannot reach/.test(e)),
    result.errors.join("; "),
  );
  // The seams around it still measure open: only the geometry changed.
  assert.ok(widths.some((w) => w > 0));
});
