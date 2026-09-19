import test from "node:test";
import assert from "node:assert/strict";
import { tileShape, validateTileShape } from "../src/tiles.ts";
import { validateLibrary, DEFAULT_LIBRARY } from "../src/core.ts";
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
    cells: ["......", ".#....", "......", "......", "......", "......"],
    walls: [{ x1: 1, y1: 3, x2: 5, y2: 3, gap: 1.5 }],
  });
  const solidAt = (deg: number) => {
    const { blocked } = tileShape(tile, deg);
    const i = [...blocked].findIndex((v) => v === 1);
    return [i % 6, Math.floor(i / 6)];
  };
  // A solid cell in the north-west corner walks the corners clockwise.
  assert.deepEqual(solidAt(0), [1, 1]);
  assert.deepEqual(solidAt(90), [4, 1]);
  assert.deepEqual(solidAt(180), [4, 4]);
  assert.deepEqual(solidAt(270), [1, 4]);
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

test("a filled cell takes the material class and states its own walls", () => {
  const shape = tileShape(
    template({
      cells: ["......", ".#....", "......", "......", "......", "......"],
    }),
    0,
  );
  assert.equal(shape.classes[1 * 6 + 1], "solid");
  assert.equal(shape.classes[0], "open");
  assert.ok(shape.blocked[1 * 6 + 1]);
  // Four unit edges, merged into four runs around the single cell.
  assert.equal(shape.walls.length, 4);
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
  const declared = new Set(Object.keys(DEFAULT_LIBRARY.cellClasses ?? {}));
  for (const tile of DEFAULT_LIBRARY.tiles) {
    assert.ok(
      declared.has(tile.defaultCellClass),
      `missing rule for ${tile.defaultCellClass}`,
    );
    for (const painted of Object.values(tile.legend ?? {}))
      assert.ok(declared.has(painted), `missing rule for ${painted}`);
  }
});
