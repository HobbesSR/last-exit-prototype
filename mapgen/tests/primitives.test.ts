import test from "node:test";
import assert from "node:assert/strict";
import {
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
  OUTSIDE_CLASS,
  cellIndexAt,
  generateMap,
  gridViews,
  DEFAULT_LIBRARY,
} from "../src/core.ts";
import { getRotatedEdge } from "../src/wfc.ts";
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
  const wallsOffNorth = template({
    edges: { N: ["wall", "wall", "wall", "wall", "wall", "wall"] },
  });
  assert.equal(
    resolvePrimitives(tilePrimitives(wallsOffNorth), { N: door }),
    null,
  );
  assert.ok(resolvePrimitives(tilePrimitives(wallsOffNorth), { N: sealed }));

  const needsDoor = template({
    edges: { N: ["any", "any", "open", "open", "any", "any"] },
  });
  assert.ok(resolvePrimitives(tilePrimitives(needsDoor), { N: door }));
  assert.equal(
    resolvePrimitives(tilePrimitives(needsDoor), { N: sealed }),
    null,
  );
});

test("perimeter declarations turn with the template", () => {
  const tile = template({
    edges: { N: ["wall", "wall", "wall", "wall", "wall", "wall"] },
  });
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
      cells: { "2,2": { class: "vault" }, "3,3": { class: "court" } },
      segments: { "h:3,2": "wall" },
      vertices: { "0,1": { height: 0, class: "post" } },
    },
  });
  const p = tilePrimitives(tile, 0);
  assert.equal(p.cells[cellAt(2, 2)]!.class, "vault");
  assert.equal(p.cells[cellAt(3, 3)]!.class, "court");
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

test("the shipped library states a contract per segment, not just per side", () => {
  // A perimeter segment can constrain the class of the cell across it. The
  // market front states it per segment along its south side, and wherever it
  // lands, however it turns, the neighbouring cells take that class.
  const front = DEFAULT_LIBRARY.tiles.find((t) => t.id === "market-front")!;
  assert.deepEqual(front.edges?.S, new Array(6).fill("market"));
  const m = generateMap("arcade");
  assert.equal(m.validation.valid, true, m.validation.errors.join("; "));
  const views = gridViews(m);
  const placements = m.tiles.filter((t) => t.templateId === "market-front");
  assert.ok(placements.length > 0, "expected the market front to be placed");
  let checked = 0;
  for (const tile of placements) {
    const option = {
      templateId: tile.templateId,
      orientation: tile.orientation as 0 | 90 | 180 | 270,
      difficulty: 0,
      weight: 1,
    };
    for (const side of ["N", "E", "S", "W"] as Side[]) {
      const required = getRotatedEdge(option, side, DEFAULT_LIBRARY.tiles);
      for (let i = 0; i < 6; i++) {
        if (required[i] === "any") continue;
        const [x, y] =
          side === "N"
            ? [tile.x + i, tile.y - 1]
            : side === "S"
              ? [tile.x + i, tile.y + 6]
              : side === "W"
                ? [tile.x - 1, tile.y + i]
                : [tile.x + 6, tile.y + i];
        const cell = cellIndexAt(m, x, y);
        // Across the map boundary there is nothing to constrain.
        if (cell < 0 || views.cellClass(cell) === OUTSIDE_CLASS) continue;
        assert.equal(
          views.cellClass(cell),
          required[i],
          `${tile.id} ${side} segment ${i}`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, "expected a market front with a neighbour to check");
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
