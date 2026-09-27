import test from "node:test";
import assert from "node:assert/strict";
import { tileShape, validateTileShape } from "../src/tiles.ts";
import {
  cellClassNames,
  validateLibrary,
  DEFAULT_LIBRARY,
  DEFAULT_PARAMS,
} from "../src/core.ts";
import { compileSetPiece } from "../src/macro-compiler.ts";
import { composeMacro } from "../src/macro.ts";
import { nodeIndex, reachable } from "../src/nav.ts";
import type { Library, TileDesign } from "../src/types.ts";

function template(extra: Partial<TileDesign> = {}): TileDesign {
  return {
    id: "probe",
    defaultCellClass: "open",
    orientations: [0, 90, 180, 270],
    ports: { N: "any", E: "any", S: "any", W: "any" },
    ...extra,
  };
}
function libraryWith(tile: TileDesign): Library {
  return {
    version: 1,
    // Every class a tile paints has to be declared.
    cellClasses: Object.fromEntries(
      [tile.defaultCellClass, ...Object.values(tile.legend ?? {})].map((n) => [
        n,
        {},
      ]),
    ),
    tiles: [tile],
    tileSets: [{ id: "only", members: [tile.id] }],
    setPieces: [],
  };
}

test("interiors rotate with the template", () => {
  const tile = template({
    legend: { v: "vault" },
    cells: ["......", ".v....", "......", "......", "......", "......"],
    walls: [{ x1: 1, y1: 3, x2: 5, y2: 3, gap: 1.5 }],
  });
  const paintedAt = (deg: number) => {
    const i = tileShape(tile, deg).classes.indexOf("vault");
    return [i % 6, Math.floor(i / 6)];
  };
  // A painted cell in the north-west corner walks the corners clockwise.
  assert.deepEqual(paintedAt(0), [1, 1]);
  assert.deepEqual(paintedAt(90), [4, 1]);
  assert.deepEqual(paintedAt(180), [4, 4]);
  assert.deepEqual(paintedAt(270), [1, 4]);
  // The gapped wall turns with it and keeps its aperture.
  const flat = tileShape(tile, 0).walls.filter(
    (w) => w.y1 === w.y2 && w.y1 === 3,
  );
  const turned = tileShape(tile, 90).walls.filter(
    (w) => w.x1 === w.x2 && w.x1 === 3,
  );
  assert.equal(flat.length, 2);
  assert.equal(turned.length, 2);
  const span = (list: typeof flat, axis: "x" | "y") =>
    list.reduce(
      (total, w) => total + Math.abs(w[`${axis}2`] - w[`${axis}1`]),
      0,
    );
  assert.equal(span(flat, "x"), 4 - 1.5);
  assert.equal(span(turned, "y"), 4 - 1.5);
});

test("painted cells carry their own region class", () => {
  const shape = tileShape(
    template({
      legend: { v: "vault" },
      cells: ["......", "......", "..vv..", "..vv..", "......", "......"],
    }),
    0,
  );
  assert.equal(shape.classes[2 * 6 + 2], "vault");
  assert.equal(shape.classes[2 * 6 + 4], "open");
  assert.equal(shape.walls.length, 0, "paint alone creates no geometry");
});

test("interior authoring errors are explicit", () => {
  const cases: Array<[string, Partial<TileDesign>]> = [
    [
      "legend",
      { cells: ["......", ".q....", "......", "......", "......", "......"] },
    ],
    ["rows", { cells: ["....", "......"] }],
    ["outside", { walls: [{ x1: -1, y1: 3, x2: 5, y2: 3 }] }],
    ["diagonal", { walls: [{ x1: 1, y1: 1, x2: 4, y2: 4 }] }],
    ["gap", { walls: [{ x1: 1, y1: 3, x2: 5, y2: 3, gap: 9 }] }],
    ["offgrid", { walls: [{ x1: 1, y1: 2.5, x2: 5, y2: 2.5 }] }],
    // Tiles paint zones; material is laid only by micro builders, and every
    // route a tile has to it is refused rather than quietly repainted.
    [
      "material mark",
      { cells: ["......", ".#....", "......", "......", "......", "......"] },
    ],
    [
      "material legend",
      {
        legend: { m: "solid" },
        cells: ["......", ".m....", "......", "......", "......", "......"],
      },
    ],
    [
      "material override",
      { primitives: { cells: { "2,2": { class: "solid" } } } },
    ],
    ["material default", { defaultCellClass: "solid" }],
  ];
  for (const [name, extra] of cases)
    assert.ok(
      validateTileShape(template(extra)).length > 0,
      `${name} should be rejected`,
    );
  assert.deepEqual(validateTileShape(template()), []);
  assert.equal(validateLibrary(libraryWith(template())).valid, true);
});

test("the shipped library declares every class it can paint", () => {
  // Declared classes plus the reserved deferring class, which is never listed.
  const declared = new Set(cellClassNames(DEFAULT_LIBRARY));
  for (const tile of DEFAULT_LIBRARY.tiles) {
    assert.ok(
      declared.has(tile.defaultCellClass),
      `missing rule for ${tile.defaultCellClass}`,
    );
    for (const painted of Object.values(tile.legend ?? {}))
      assert.ok(declared.has(painted), `missing rule for ${painted}`);
  }
});

test("every shipped set piece can be walked into from open ground", () => {
  // Each piece alone, ringed by a tile of open ground, with its unassigned
  // slots left open as WFC might leave them. A body walking in from the ring
  // must reach the middle of every slot: a fenced compound with no gate fails
  // here rather than as a batch of unwalkable maps.
  const size = DEFAULT_PARAMS.tileSize;
  for (const piece of DEFAULT_LIBRARY.setPieces ?? []) {
    const columns = Math.max(...piece.tiles.map((t) => t.dx)) + 3;
    const rows = Math.max(...piece.tiles.map((t) => t.dy)) + 3;
    const mask = [];
    for (let y = 0; y < rows * size; y++)
      for (let x = 0; x < columns * size; x++) mask.push({ x, y });
    const map = composeMacro({
      version: 1,
      seed: piece.id,
      width: columns * size,
      height: rows * size,
      mask,
      defaultCellClass: "grass",
      placements: [
        {
          id: piece.id,
          structure: compileSetPiece(piece, DEFAULT_LIBRARY, () => 0),
          origin: { x: size, y: size },
          orientation: 0,
        },
      ],
    });
    const radius = DEFAULT_PARAMS.contestantRadius;
    const reached = reachable(map, radius, size / 2, size / 2, [
      0,
      0,
      map.width,
      map.height,
    ]);
    for (let row = 1; row < rows - 1; row++)
      for (let column = 1; column < columns - 1; column++) {
        const x = column * size + size / 2,
          y = row * size + size / 2;
        assert.ok(
          reached.has(nodeIndex(map, x, y)),
          `${piece.id}: slot ${column - 1},${row - 1} is sealed off`,
        );
      }
  }
});
