import test from "node:test";
import assert from "node:assert/strict";
import {
  SOLID_CLASS,
  ANY_CLASS,
  channelSpan,
  CELL_COUNT,
  SEGMENT_COUNT,
  VERTEX_COUNT,
  apertureContract,
  cellAt,
  hSeg,
  isPerimeterVertex,
  resolvePrimitives,
  segmentDeclaration,
  sideSegment,
  sideVertex,
  spanLength,
  tilePrimitives,
  vSeg,
  vertexAt,
  vertexMeta,
} from "../src/primitives.ts";
import {
  decodeGrid,
  encodeGrid,
  gridReader,
  uniformGrid,
  validateGrid,
} from "../src/coding.ts";
import {
  generateMap,
  gridViews,
  segmentIndexAt,
  DEFAULT_LIBRARY,
} from "../src/core.ts";
import type { Side, TileDesign } from "../src/types.ts";

function template(extra: Partial<TileDesign> = {}): TileDesign {
  return {
    id: "probe",
    defaultCellClass: "open",
    orientations: [0, 90, 180, 270],
    ports: { N: "any", E: "any", S: "any", W: "any" },
    ...extra,
  };
}
const sealed = { segments: apertureContract(0).map(() => null), vertices: [] };
const door = { segments: apertureContract(2), vertices: [] };

test("every primitive is addressable, but only statements are stored", () => {
  const p = tilePrimitives(template());
  // Cells are dense because each one genuinely differs.
  assert.equal(p.cells.length, CELL_COUNT);
  assert.ok(p.cells.every((c) => c.class === "open"));
  // A template that states nothing stores nothing for the other two sets, yet
  // every one of them still answers.
  assert.equal(p.segments.size, 0);
  assert.equal(p.vertices.size, 0);
  for (let i = 0; i < SEGMENT_COUNT; i++)
    assert.equal(segmentDeclaration(p, i), "any");
  for (let i = 0; i < VERTEX_COUNT; i++)
    assert.deepEqual(vertexMeta(p, i), { height: "any", class: ANY_CLASS });
});

test("only perimeter vertices carry metadata", async () => {
  assert.ok(isPerimeterVertex(vertexAt(0, 3)));
  assert.ok(isPerimeterVertex(vertexAt(6, 6)));
  assert.ok(!isPerimeterVertex(vertexAt(3, 3)));
  // An interior vertex is a mistake worth reporting, not silently ignoring.
  const { validateTileShape } = await import("../src/tiles.ts");
  assert.ok(
    validateTileShape(
      template({ primitives: { vertices: { "3,3": { class: "post" } } } }),
    ).some((e) => /interior/.test(e)),
  );
  assert.deepEqual(
    validateTileShape(
      template({ primitives: { vertices: { "0,3": { class: "post" } } } }),
    ),
    [],
  );
});

test("a filled cell is metadata plus stated walls, not a region class", () => {
  const p = tilePrimitives(
    template({
      cells: ["......", ".#....", "......", "......", "......", "......"],
    }),
  );
  // "#" resolves to the reserved material class, like any other paint.
  assert.equal(p.cells[cellAt(1, 1)]!.class, SOLID_CLASS);
  // It states the four walls facing its unfilled neighbours, and nothing else.
  assert.equal(p.segments.size, 4);
  assert.equal(segmentDeclaration(p, vSeg(1, 1)), "wall");
  assert.equal(segmentDeclaration(p, hSeg(1, 1)), "wall");
});

test("a deferring perimeter adopts the seam contract", () => {
  const p = tilePrimitives(template());
  const resolved = resolvePrimitives(p, { N: door, S: sealed })!;
  assert.ok(resolved);
  // A 2-wide door centred on six segments opens exactly the middle two.
  const north = [0, 1, 2, 3, 4, 5].map((i) =>
    spanLength(resolved.open[sideSegment("N", i)]!),
  );
  assert.deepEqual(north, [0, 0, 1, 1, 0, 0]);
  for (let i = 0; i < 6; i++)
    assert.equal(spanLength(resolved.open[sideSegment("S", i)]!), 0);
  // Interior deferrals settle as clear, so paths are not accidentally blocked.
  assert.equal(spanLength(resolved.open[vSeg(3, 3)]!), 1);
});

test("a concrete perimeter declaration is a requirement, not a preference", () => {
  const wallsOffNorth = template({ edges: { N: "######" } });
  assert.equal(
    resolvePrimitives(tilePrimitives(wallsOffNorth), { N: door }),
    null,
  );
  assert.ok(resolvePrimitives(tilePrimitives(wallsOffNorth), { N: sealed }));

  const needsDoor = template({ edges: { N: "..oo.." } });
  assert.ok(resolvePrimitives(tilePrimitives(needsDoor), { N: door }));
  assert.equal(
    resolvePrimitives(tilePrimitives(needsDoor), { N: sealed }),
    null,
  );
});

test("perimeter declarations turn with the template", () => {
  const tile = template({ edges: { N: "######" } });
  const sealedSide = (deg: number): Side | undefined =>
    (["N", "E", "S", "W"] as Side[]).find((side) =>
      [0, 1, 2, 3, 4, 5].every(
        (i) =>
          segmentDeclaration(
            tilePrimitives(tile, deg),
            sideSegment(side, i),
          ) === "wall",
      ),
    );
  assert.equal(sealedSide(0), "N");
  assert.equal(sealedSide(90), "E");
  assert.equal(sealedSide(180), "S");
  assert.equal(sealedSide(270), "W");
});

test("vertex metadata defers, adopts, and refuses a conflict", () => {
  const declaring = template({
    corners: { N: ["arch", "arch", "arch", "arch", "arch", "arch", "arch"] },
  });
  const p = tilePrimitives(declaring);
  assert.equal(vertexMeta(p, sideVertex("N", 0)).class, "arch");
  const arch = {
    segments: apertureContract(2),
    vertices: new Array(7).fill({ height: "any", class: "arch" }),
  };
  const other = {
    segments: apertureContract(2),
    vertices: new Array(7).fill({ height: "any", class: "buttress" }),
  };
  // Matching or deferring neighbours are fine; a different class is not.
  assert.ok(resolvePrimitives(p, { N: arch }));
  assert.equal(resolvePrimitives(p, { N: other }), null);
  // A deferring tile adopts whatever the neighbour asked for.
  const adopted = resolvePrimitives(tilePrimitives(template()), { N: arch })!;
  assert.equal(adopted.vertices.get(sideVertex("N", 3))!.class, "arch");
});

test("explicit metadata overrides the shorthands", () => {
  const tile = template({
    cells: ["......", "......", "......", "......", "......", "......"],
    primitives: {
      cells: { "2,2": { class: "vault" }, "3,3": { class: SOLID_CLASS } },
      segments: { "h:3,2": "wall" },
      vertices: { "0,1": { height: 0, class: "post" } },
    },
  });
  const p = tilePrimitives(tile);
  assert.equal(p.cells[cellAt(2, 2)]!.class, "vault");
  assert.equal(p.cells[cellAt(3, 3)]!.class, SOLID_CLASS);
  assert.equal(segmentDeclaration(p, hSeg(3, 2)), "wall");
  assert.equal(vertexMeta(p, vertexAt(0, 1)).class, "post");
});

test("segment declarations can specify separate channels", () => {
  const p = tilePrimitives(
    template({
      primitives: {
        segments: { "h:3,2": { move: "wall", sight: "open", shot: "open" } },
      },
    }),
  );
  const decl = segmentDeclaration(p, hSeg(3, 2));
  assert.deepEqual(decl, { move: "wall", sight: "open", shot: "open" });
  assert.deepEqual(channelSpan(decl, "move"), null);
  assert.deepEqual(channelSpan(decl, "sight"), [0, 1]);
});

test("solid overrides derive boundaries before explicit segment overrides", () => {
  const cleared = tilePrimitives(
    template({
      cells: ["......", ".#....", "......", "......", "......", "......"],
      primitives: {
        cells: { "1,1": { class: "open" } },
        segments: { "h:1,1": "wall" },
      },
    }),
  );
  assert.equal(cleared.cells[cellAt(1, 1)]!.class, "open");
  // Clearing a filled cell removes its derived boundaries, but a stated wall remains.
  assert.equal(cleared.segments.size, 1);
  assert.equal(segmentDeclaration(cleared, hSeg(1, 1)), "wall");

  const filled = tilePrimitives(
    template({
      primitives: {
        cells: { "2,2": { class: SOLID_CLASS } },
        segments: { "h:2,2": "any", "v:2,2": [0.25, 0.75] },
      },
    }),
  );
  assert.equal(filled.cells[cellAt(2, 2)]!.class, SOLID_CLASS);
  // A new solid cell derives its remaining three boundaries; stated segments win.
  assert.equal(filled.segments.size, 3);
  assert.equal(segmentDeclaration(filled, hSeg(2, 2)), "any");
  assert.deepEqual(segmentDeclaration(filled, vSeg(2, 2)), [0.25, 0.75]);
});

test("the shipped library states a contract per segment, not just per side", () => {
  const arcade = DEFAULT_LIBRARY.tiles.find((t) => t.id === "market-arcade")!;
  assert.ok(arcade.edges?.E && arcade.edges?.W);
  assert.ok(
    Object.values(arcade.ports ?? {}).every((port) => port === "any"),
    "the coarse ports defer; the per-segment contract does the work",
  );
  const m = generateMap("arcade");
  assert.equal(m.validation.valid, true);
  const views = gridViews(m);
  const placements = m.tiles.filter((t) => t.templateId === "market-arcade");
  assert.ok(placements.length > 0, "expected the arcade to be placed");
  // Wherever it landed, and however it turned, two opposite sides are sealed.
  for (const tile of placements) {
    const openAlong = (side: Side) => {
      let total = 0;
      for (let i = 0; i < 6; i++) {
        const vertical = side === "E" || side === "W";
        const line =
          side === "W"
            ? tile.x
            : side === "E"
              ? tile.x + 6
              : side === "N"
                ? tile.y
                : tile.y + 6;
        const offset = (vertical ? tile.y : tile.x) + i;
        total += spanLength(
          views.segmentOpen(segmentIndexAt(m, vertical, line, offset)),
        );
      }
      return total;
    };
    const shut = (["N", "E", "S", "W"] as Side[]).filter(
      (side) => openAlong(side) === 0,
    );
    assert.ok(
      (shut.includes("E") && shut.includes("W")) ||
        (shut.includes("N") && shut.includes("S")),
      `arcade at ${tile.id} sealed ${shut.join("/")}`,
    );
  }
});

test("coded grids round-trip and are validated", () => {
  const values = ["a", "a", "a", "b", "b", "c"];
  const grid = encodeGrid(values);
  assert.deepEqual(grid.palette, ["a", "b", "c"]);
  assert.deepEqual(grid.runs, [3, 0, 2, 1, 1, 2]);
  assert.deepEqual(decodeGrid(grid), values);
  const read = gridReader(grid);
  assert.deepEqual(
    values.map((_, i) => read(i)),
    values,
  );
  // Backwards reads rewind rather than returning stale runs.
  assert.equal(read(0), "a");
  assert.equal(read(5), "c");
  assert.deepEqual(validateGrid(grid, "probe", 6), []);
  assert.ok(validateGrid(grid, "probe", 7).length > 0);
  assert.ok(
    validateGrid({ palette: [], runs: [1, 0], count: 1 }, "probe", 1).length >
      0,
  );
  assert.deepEqual(decodeGrid(uniformGrid(null, 4)), [null, null, null, null]);
  // Structured values intern by content, not by identity.
  const spans = encodeGrid([[0, 1], [0, 1], null]);
  assert.equal(spans.palette.length, 2);
});

test("the artifact stays small because primitives are enumerated", () => {
  const m = generateMap("size");
  const bytes = JSON.stringify(m).length;
  const primitives =
    m.grid.cells.class.count +
    m.grid.segments.open.count +
    (m.grid.width + 1) * (m.grid.height + 1);
  assert.ok(primitives > 40000, "the map really does carry that many");
  // A budget per primitive rather than an absolute size, so the assertion keeps
  // its meaning when the default map dimensions change.
  assert.ok(
    bytes < primitives * 5,
    `expected a compact artifact, got ${bytes} bytes for ${primitives} primitives`,
  );
});
