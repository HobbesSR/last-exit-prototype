import test from "node:test";
import assert from "node:assert/strict";
import { checkMacroRoutes, composeMacro } from "../src/macro.ts";
import { nodeIndex, occupiable, reachable, segmentClear } from "../src/nav.ts";
import type {
  MacroCompositionInput,
  MacroSegment,
  MacroStructure,
} from "../src/macro-types.ts";
import type { NavTarget, Point } from "../src/types.ts";

function cells(x0: number, y0: number, width: number, height: number): Point[] {
  return Array.from({ length: width * height }, (_, i) => ({
    x: x0 + (i % width),
    y: y0 + Math.floor(i / width),
  }));
}
function input(width = 18, height = 12): MacroCompositionInput {
  return {
    version: 1,
    seed: "macro-contract",
    width,
    height,
    mask: cells(0, 0, width, height),
    defaultCellClass: "field",
    placements: [],
  };
}
function wall(
  axis: "h" | "v",
  x: number,
  y: number,
  length: number,
): MacroSegment[] {
  return Array.from({ length }, (_, i) => ({
    axis,
    x: x + (axis === "h" ? i : 0),
    y: y + (axis === "v" ? i : 0),
    open: null,
  }));
}
function connects(
  map: NavTarget,
  radius: number,
  from: Point,
  to: Point,
): boolean {
  return reachable(map, radius, from.x, from.y, [
    0,
    0,
    map.width,
    map.height,
  ]).has(nodeIndex(map, to.x, to.y));
}

test("macro: ordinary field crosses seams and four-tile meetings without walls", () => {
  const source = input(12, 12);
  source.placements.push({
    id: "uniform-tile",
    origin: { x: 0, y: 0 },
    orientation: 0,
    structure: {
      version: 1,
      id: "field-patch",
      defaultCellClass: "field",
      cells: cells(0, 0, 6, 6),
    },
  });
  const map = composeMacro(source);
  assert.equal(map.regions.length, 1);
  assert.equal(map.regions[0].area, 144);
  assert.equal(map.cellOwner.filter((x) => x === "uniform-tile").length, 36);
  assert.equal(map.walls.length, 4, "only the mask perimeter emits walls");
  for (const radius of [0.55, 0.9]) {
    assert.ok(
      segmentClear(map, 2, 2, 10, 10, radius),
      "diagonal crosses the four-tile meeting",
    );
    assert.ok(connects(map, radius, { x: 3, y: 3 }, { x: 9, y: 9 }));
  }
  assert.deepEqual(composeMacro(source), map, "composition is deterministic");
});

test("macro: building spans tiles with an off-centre entrance and cell-derived regions", () => {
  const source = input();
  const building: MacroStructure = {
    version: 1,
    id: "building",
    defaultCellClass: "hall",
    cells: cells(0, 0, 10, 8),
    segments: [
      ...wall("h", 0, 0, 10),
      ...wall("v", 0, 0, 8),
      ...wall("v", 10, 0, 8),
      ...wall("h", 0, 8, 2),
      ...wall("h", 4, 8, 6),
    ],
    entrances: [{ id: "door", x: 3, y: 8 }],
    corridors: [
      {
        id: "door-approach",
        points: [
          { x: 3, y: 6 },
          { x: 3, y: 8 },
        ],
        radius: 0.9,
      },
    ],
  };
  source.placements.push({
    id: "hall",
    structure: building,
    origin: { x: 3, y: 2 },
    orientation: 0,
  });
  const map = composeMacro(source);
  assert.equal(map.regions.find((r) => r.cellClass === "hall")?.area, 80);
  assert.deepEqual(map.entrances, [
    { id: "door", placementId: "hall", x: 6, y: 10 },
  ]);
  assert.ok(segmentClear(map, 6, 11, 6, 7, 0.9));
  assert.equal(segmentClear(map, 10, 11, 10, 7, 0.55), false);
  assert.ok(connects(map, 0.9, { x: 6, y: 11 }, { x: 10, y: 5 }));
  assert.equal(map.manifest.corridorsChecked, 1);
});

test("macro: a cross-tile cul-de-sac has a physical cap and one open mouth", () => {
  const source = input();
  source.placements.push({
    id: "lane",
    origin: { x: 2, y: 4 },
    orientation: 0,
    structure: {
      version: 1,
      id: "blind-lane",
      defaultCellClass: "street",
      cells: cells(0, 0, 13, 4),
      segments: [
        ...wall("h", 0, 0, 13),
        ...wall("h", 0, 4, 13),
        ...wall("v", 13, 0, 4),
      ],
      corridors: [
        {
          id: "lane",
          points: [
            { x: 1, y: 2 },
            { x: 11, y: 2 },
          ],
          radius: 0.9,
        },
      ],
    },
  });
  const map = composeMacro(source);
  assert.ok(
    segmentClear(map, 1, 6, 14, 6, 0.9),
    "mouth and cross-seam lane are open",
  );
  assert.equal(
    segmentClear(map, 14, 6, 16, 6, 0.55),
    false,
    "cap blocks continuation",
  );
  assert.equal(
    segmentClear(map, 10, 6, 10, 9, 0.55),
    false,
    "side blocks escape",
  );
  assert.ok(connects(map, 0.9, { x: 14, y: 6 }, { x: 1, y: 6 }));
  assert.equal(
    "deadEnds" in map,
    false,
    "fixture makes no tile-degree dead-end claim",
  );
});

test("macro: one 1.5-cell aperture produces different body connectivity", () => {
  const source = input(12, 12);
  const segments = wall("v", 6, 0, 12);
  segments[5].open = [0.25, 1];
  segments[6].open = [0, 0.75];
  source.placements.push({
    id: "cut",
    origin: { x: 0, y: 0 },
    orientation: 0,
    structure: {
      version: 1,
      id: "squeeze-cut",
      defaultCellClass: "field",
      cells: cells(5, 0, 1, 12),
      segments,
      constraints: [
        {
          id: "contestant-crosses",
          from: { x: 5, y: 6 },
          to: { x: 6, y: 6 },
          radius: 0.55,
          connected: true,
        },
      ],
    },
  });
  const map = composeMacro(source);
  assert.ok(connects(map, 0.55, { x: 3, y: 6 }, { x: 9, y: 6 }));
  assert.equal(connects(map, 0.9, { x: 3, y: 6 }, { x: 9, y: 6 }), false);
  assert.ok(segmentClear(map, 3, 6, 9, 6, 0.55));
  assert.equal(segmentClear(map, 3, 6, 9, 6, 0.9), false);
});

test("macro: overlapping ownership and contradictory shared segments fail in either order", () => {
  const source = input(12, 6);
  const left: MacroStructure = {
    version: 1,
    id: "left",
    defaultCellClass: "field",
    cells: cells(0, 0, 6, 6),
    segments: [{ axis: "v", x: 6, y: 2, open: null }],
  };
  const right: MacroStructure = {
    version: 1,
    id: "right",
    defaultCellClass: "field",
    cells: cells(0, 0, 6, 6),
    segments: [{ axis: "v", x: 0, y: 2, open: [0, 1] }],
  };
  source.placements = [
    { id: "a", structure: left, origin: { x: 0, y: 0 }, orientation: 0 },
    { id: "b", structure: right, origin: { x: 6, y: 0 }, orientation: 0 },
  ];
  assert.throws(() => composeMacro(source));
  source.placements.reverse();
  assert.throws(() => composeMacro(source));
  right.segments![0].open = null;
  const map = composeMacro(source);
  source.placements.reverse();
  assert.deepEqual(composeMacro(source).walls, map.walls);
  source.placements[1].origin.x = 5;
  assert.throws(() => composeMacro(source));
});

test("macro: rotation transforms cell ownership, entrances and asymmetric apertures", () => {
  const source = input(12, 12);
  source.placements = [
    {
      id: "rotated",
      origin: { x: 8, y: 2 },
      orientation: 90,
      structure: {
        version: 1,
        id: "patch",
        defaultCellClass: "court",
        cells: cells(0, 0, 3, 4),
        segments: [{ axis: "v", x: 1, y: 1, open: [0, 0.25] }],
        entrances: [{ id: "marker", x: 1, y: 1 }],
      },
    },
  ];
  const map = composeMacro(source);
  assert.equal(map.cellOwner[2 * 12 + 4], "rotated");
  assert.equal(map.cellOwner[4 * 12 + 7], "rotated");
  assert.deepEqual(map.entrances[0], {
    id: "marker",
    placementId: "rotated",
    x: 7,
    y: 3,
  });
  assert.ok(
    map.walls.some(
      (w) => w.y1 === 3 && w.y2 === 3 && w.x1 === 6 && w.x2 === 6.75,
    ),
  );
});

test("macro: route constraints and reservations are checked against final neighbouring geometry", () => {
  const source = input(12, 6);
  source.placements = [
    {
      id: "path",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "path",
        defaultCellClass: "field",
        cells: cells(0, 0, 6, 6),
        corridors: [
          {
            id: "protected",
            points: [
              { x: 2, y: 3 },
              { x: 6, y: 3 },
            ],
            radius: 0.9,
          },
        ],
      },
    },
    {
      id: "barrier",
      origin: { x: 6, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "barrier",
        defaultCellClass: "field",
        cells: cells(0, 0, 6, 6),
        segments: wall("v", 0, 0, 6),
      },
    },
  ];
  assert.throws(() => composeMacro(source));
  source.placements[0].structure.corridors = [];
  source.placements[0].structure.constraints = [
    {
      id: "blocked",
      from: { x: 2, y: 3 },
      to: { x: 6, y: 3 },
      radius: 0.9,
      connected: false,
    },
  ];
  assert.throws(
    () => composeMacro(source),
    "a blocked endpoint is not a successful requested cut",
  );
});

test("macro: mask holes and filled cells exclude standing space and cannot be carved by open declarations", () => {
  const source = input(12, 12);
  source.mask = source.mask.filter(
    (p) => !(p.x >= 5 && p.x <= 6 && p.y >= 5 && p.y <= 6),
  );
  const map = composeMacro(source);
  assert.equal(map.regions[0].area, 140);
  assert.equal(segmentClear(map, 3, 6, 9, 6, 0.55), false);
  source.placements = [
    {
      id: "solid",
      origin: { x: 1, y: 1 },
      orientation: 0,
      structure: {
        version: 1,
        id: "solid",
        defaultCellClass: "field",
        cells: [{ x: 0, y: 0, class: "solid" }],
        segments: [{ axis: "h", x: 0, y: 0, open: [0, 1] }],
      },
    },
  ];
  assert.doesNotThrow(() => composeMacro(source));
});

test("macro: requested cuts are evaluated after composition and reported as sampled results", () => {
  const source = input(12, 6);
  source.placements = [
    {
      id: "cut",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "split",
        defaultCellClass: "field",
        cells: cells(0, 0, 12, 6),
        segments: wall("v", 6, 0, 6),
        constraints: [
          {
            id: "separate",
            from: { x: 3, y: 3 },
            to: { x: 9, y: 3 },
            radius: 0.9,
            connected: false,
          },
        ],
      },
    },
  ];
  assert.deepEqual(composeMacro(source).manifest.constraints, [
    { placementId: "cut", id: "separate", connected: false },
  ]);
  const retained = composeMacro(source);
  assert.equal(retained.seed, source.seed);
  assert.equal(retained.segmentOpen.length, 13 * 6 + 7 * 12);
  assert.deepEqual(retained.constraints, [
    {
      placementId: "cut",
      id: "separate",
      from: { x: 3, y: 3 },
      to: { x: 9, y: 3 },
      radius: 0.9,
      connected: false,
    },
  ]);
  source.placements[0].structure.constraints![0].from.x = 2;
  assert.equal(
    retained.constraints[0].from.x,
    3,
    "output definitions do not alias author input",
  );
  source.placements[0].structure.segments = [];
  assert.throws(() => composeMacro(source), /connectivity/);
  source.placements[0].structure.constraints![0].connected = true;
  assert.equal(composeMacro(source).manifest.constraints[0].connected, true);
});

test("macro: disconnected footprints preserve filler and corridor centre lines cannot cross unowned holes", () => {
  const source = input(12, 6);
  const patch: MacroStructure = {
    version: 1,
    id: "islands",
    defaultCellClass: "court",
    cells: [...cells(0, 0, 2, 2), ...cells(4, 0, 2, 2)],
  };
  source.placements = [
    { id: "islands", origin: { x: 2, y: 2 }, orientation: 0, structure: patch },
  ];
  const map = composeMacro(source);
  assert.equal(map.cellClass[2 * 12 + 4], "field");
  assert.equal(map.cellOwner[2 * 12 + 4], null);
  assert.equal(map.regions.filter((r) => r.cellClass === "court").length, 2);
  patch.corridors = [
    {
      id: "unsupported",
      points: [
        { x: 1, y: 1 },
        { x: 5, y: 1 },
      ],
      radius: 0.55,
    },
  ];
  assert.throws(() => composeMacro(source), /footprint/);
});

test("macro: composition rejects invalid versions, duplicate mask cells and unsafe coordinates", () => {
  const source = input(6, 6);
  assert.throws(() =>
    composeMacro({ ...source, version: 2 } as unknown as MacroCompositionInput),
  );
  assert.throws(() => composeMacro({ ...source, width: Infinity }));
  assert.throws(() =>
    composeMacro({ ...source, mask: [...source.mask, source.mask[0]] }),
  );
  source.placements = [
    {
      id: "bad",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "bad",
        defaultCellClass: "field",
        cells: [{ x: 0, y: 0 }],
        segments: [{ axis: "h", x: 3, y: 3, open: null }],
      },
    },
  ];
  assert.throws(() => composeMacro(source), /incident/);
  source.placements[0].structure.segments = [
    { axis: "h", x: 0, y: 0, open: [0.9, 0.1] },
  ];
  assert.throws(() => composeMacro(source), /span|satisfy/);
});

test("macro: mirrored decimal spans normalize identically independent of placement order", () => {
  for (const [lo, hi] of [
    [0.25, 0.75],
    [0.3, 0.8],
    [0.1, 0.9],
    [1 / 3, 2 / 3],
  ]) {
    const source = input(12, 6);
    source.placements = [
      {
        id: "left",
        origin: { x: 0, y: 0 },
        orientation: 0,
        structure: {
          version: 1,
          id: "left",
          defaultCellClass: "field",
          cells: cells(0, 0, 6, 6),
          segments: [{ axis: "v", x: 6, y: 2, open: [lo, hi] }],
        },
      },
      {
        id: "right",
        origin: { x: 12, y: 6 },
        orientation: 180,
        structure: {
          version: 1,
          id: "right",
          defaultCellClass: "field",
          cells: cells(0, 0, 6, 6),
          segments: [{ axis: "v", x: 6, y: 3, open: [1 - hi, 1 - lo] }],
        },
      },
    ];
    const map = composeMacro(source);
    source.placements.reverse();
    assert.deepEqual(composeMacro(source).walls, map.walls);
    // A genuinely different opening still conflicts after normalization.
    source.placements[0].structure.segments![0].open = [1 - hi, 1 - lo + 1e-7];
    assert.throws(() => composeMacro(source), /conflicting/);
  }
});

test("macro: optional lists reject falsy scalars with authoring diagnostics", () => {
  for (const field of ["segments", "entrances", "corridors", "constraints"]) {
    for (const value of [0, "", false]) {
      const source = input(6, 6);
      const structure = {
        version: 1,
        id: "bad-list",
        defaultCellClass: "field",
        cells: [{ x: 0, y: 0 }],
        [field]: value,
      } as unknown as MacroStructure;
      source.placements = [
        { id: "bad", origin: { x: 0, y: 0 }, orientation: 0, structure },
      ];
      assert.throws(
        () => composeMacro(source),
        /invalid macro composition: .*must be a list/,
      );
    }
  }
});

test("macro: subprecision apertures are rejected instead of silently closed", () => {
  const source = input(6, 6);
  source.placements = [
    {
      id: "tiny",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "tiny",
        defaultCellClass: "field",
        cells: cells(0, 0, 6, 6),
        segments: [{ axis: "v", x: 3, y: 2, open: [0.5, 0.5 + 1e-12] }],
      },
    },
  ];
  assert.throws(() => composeMacro(source), /precision/);
});

test("macro: maximum-size field preserves its reserved corridor", () => {
  const source = input(366, 186);
  source.placements = [
    {
      id: "field",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "field",
        defaultCellClass: "field",
        cells: source.mask,
        corridors: [
          {
            id: "zigzag",
            radius: 0.9,
            points: Array.from({ length: 20 }, (_, i) => ({
              x: i % 2 === 0 ? 2 : 364,
              y: 2 + i * 9,
            })),
          },
        ],
      },
    },
  ];
  const map = composeMacro(source);
  assert.equal(map.manifest.corridorsChecked, 1);
  assert.equal(map.regions.length, 1);
  assert.equal(map.regions[0].area, 366 * 186);
});

test("macro: enormous finite entrance coordinates fail without unbounded containment loops", () => {
  const source = input(6, 6);
  source.placements = [
    {
      id: "field",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "field",
        defaultCellClass: "field",
        cells: source.mask,
        entrances: [{ id: "far", x: 1e100, y: 1e100 }],
      },
    },
  ];
  assert.throws(() => composeMacro(source), /footprint/);
});

/** One retained corridor and two retained constraints that differ only by radius. */
function revalidationInput(): MacroCompositionInput {
  const source = input(12, 6);
  source.placements = [
    {
      id: "site",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "site",
        defaultCellClass: "field",
        cells: cells(0, 0, 12, 6),
        corridors: [
          {
            id: "spine",
            points: [
              { x: 1, y: 3 },
              { x: 11, y: 3 },
            ],
            radius: 0.9,
          },
        ],
        constraints: [
          {
            id: "wide",
            from: { x: 1, y: 3 },
            to: { x: 11, y: 3 },
            radius: 0.9,
            connected: true,
          },
          {
            id: "narrow",
            from: { x: 1, y: 3 },
            to: { x: 11, y: 3 },
            radius: 0.55,
            connected: true,
          },
        ],
      },
    },
  ];
  return source;
}

test("checkMacroRoutes: a fresh composition rechecks clean and matches its manifest", () => {
  const map = composeMacro(revalidationInput());
  assert.deepEqual(checkMacroRoutes(map), {
    valid: true,
    errors: [],
    corridorsChecked: 1,
    constraints: [
      { placementId: "site", id: "wide", connected: true },
      { placementId: "site", id: "narrow", connected: true },
    ],
  });
  assert.equal(map.manifest.corridorsChecked, 1);
  assert.deepEqual(map.manifest.constraints, [
    { placementId: "site", id: "wide", connected: true },
    { placementId: "site", id: "narrow", connected: true },
  ]);
});

test("checkMacroRoutes: a blocker added after caches are populated fails, and removing it recovers", () => {
  const map = composeMacro(revalidationInput());
  // Populate the wall index and both lattices first: a stale cache must not be
  // able to report the pre-edit geometry.
  assert.ok(occupiable(map, 0.9, 6, 3));
  assert.ok(connects(map, 0.55, { x: 1, y: 3 }, { x: 11, y: 3 }));
  assert.ok(segmentClear(map, 1, 3, 11, 3, 0.9));

  map.walls.push({ x1: 6, y1: 2.5, x2: 6, y2: 3.5 });
  const blocked = checkMacroRoutes(map);
  assert.equal(blocked.valid, false);
  assert.equal(blocked.corridorsChecked, 0);
  assert.deepEqual(blocked.errors, [
    "corridor site/spine segment 0 is not clear in the current geometry",
  ]);
  // The stub is short enough to walk around, so both constraints still hold.
  assert.deepEqual(blocked.constraints, [
    { placementId: "site", id: "wide", connected: true },
    { placementId: "site", id: "narrow", connected: true },
  ]);
  assert.equal(segmentClear(map, 1, 3, 11, 3, 0.9), false, "actual sweep");

  map.walls.pop();
  const recovered = checkMacroRoutes(map);
  assert.equal(recovered.valid, true);
  assert.deepEqual(recovered.errors, []);
  assert.equal(recovered.corridorsChecked, 1);
  assert.ok(segmentClear(map, 1, 3, 11, 3, 0.9));
});

test("checkMacroRoutes: retained constraints are reevaluated per radius after geometry edits", () => {
  const map = composeMacro(revalidationInput());
  // A 1.2-cell aperture at x = 6: a 0.55 body fits, a 0.9 body does not.
  map.walls.push(
    { x1: 6, y1: 0, x2: 6, y2: 2.4 },
    { x1: 6, y1: 3.6, x2: 6, y2: 6 },
  );
  const report = checkMacroRoutes(map);
  assert.equal(report.valid, false);
  assert.equal(report.corridorsChecked, 0, "the 0.9 corridor no longer fits");
  assert.deepEqual(report.constraints, [
    { placementId: "site", id: "wide", connected: false },
    { placementId: "site", id: "narrow", connected: true },
  ]);
  assert.deepEqual(report.errors, [
    "corridor site/spine segment 0 is not clear in the current geometry",
    "constraint site/wide observed connectivity disagrees with declaration",
  ]);
  // Confirm the observations against the swept geometry directly.
  assert.equal(connects(map, 0.9, { x: 1, y: 3 }, { x: 11, y: 3 }), false);
  assert.ok(connects(map, 0.55, { x: 1, y: 3 }, { x: 11, y: 3 }));
});

test("checkMacroRoutes: a blocked endpoint fails even for a requested cut", () => {
  const source = input(12, 6);
  source.placements = [
    {
      id: "cut",
      origin: { x: 0, y: 0 },
      orientation: 0,
      structure: {
        version: 1,
        id: "split",
        defaultCellClass: "field",
        cells: cells(0, 0, 12, 6),
        segments: wall("v", 6, 0, 6),
        constraints: [
          {
            id: "separate",
            from: { x: 3, y: 3 },
            to: { x: 9, y: 3 },
            radius: 0.9,
            connected: false,
          },
        ],
      },
    },
  ];
  const map = composeMacro(source);
  assert.deepEqual(checkMacroRoutes(map).constraints, [
    { placementId: "cut", id: "separate", connected: false },
  ]);
  map.walls.push({ x1: 3, y1: 2.5, x2: 3, y2: 3.5 });
  const report = checkMacroRoutes(map);
  assert.equal(report.valid, false);
  assert.deepEqual(report.errors, [
    "constraint cut/separate has a blocked endpoint",
  ]);
  assert.deepEqual(
    report.constraints,
    [],
    "a body that cannot stand on an endpoint has not satisfied the cut",
  );
  assert.equal(occupiable(map, 0.9, 3, 3), false);
});

test("checkMacroRoutes: reports are fresh and never alias or rewrite the composition", () => {
  const map = composeMacro(revalidationInput());
  const before = {
    walls: structuredClone(map.walls),
    constraints: structuredClone(map.constraints),
    corridors: structuredClone(map.corridors),
    manifest: structuredClone(map.manifest),
    regions: structuredClone(map.regions),
    segmentOpen: structuredClone(map.segmentOpen),
  };
  const first = checkMacroRoutes(map);
  const second = checkMacroRoutes(map);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.constraints, second.constraints);
  assert.notEqual(first.constraints[0], second.constraints[0]);
  assert.notEqual(first.constraints, map.manifest.constraints);
  assert.notEqual(first.constraints[0], map.manifest.constraints[0]);

  first.errors.push("caller scribble");
  first.constraints[0].connected = false;
  first.corridorsChecked = 99;
  assert.deepEqual(
    checkMacroRoutes(map),
    second,
    "a later report is unaffected",
  );
  assert.deepEqual(map.walls, before.walls);
  assert.deepEqual(map.constraints, before.constraints);
  assert.deepEqual(map.corridors, before.corridors);
  assert.deepEqual(map.manifest, before.manifest);
  assert.deepEqual(map.regions, before.regions);
  assert.deepEqual(map.segmentOpen, before.segmentOpen);
});

test("checkMacroRoutes: non-finite wall coordinates fail without any navigation work", () => {
  const map = composeMacro(revalidationInput());
  const records = map.walls;
  records.push({ x1: 3, y1: Number.NaN, x2: 3, y2: 4 });
  let indexReads = 0;
  map.walls = new Proxy(records, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property))
        indexReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const report = checkMacroRoutes(map);
  assert.deepEqual(report, {
    valid: false,
    errors: [`wall ${records.length - 1}.y1 must be finite`],
    corridorsChecked: 0,
    constraints: [],
  });
  assert.equal(
    indexReads,
    records.length,
    "each record is read once for validation and never swept or indexed",
  );

  records.pop();
  const recovered = checkMacroRoutes(map);
  assert.equal(recovered.valid, true);
  assert.equal(recovered.corridorsChecked, 1);
});
