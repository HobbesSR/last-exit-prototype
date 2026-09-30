/**
 * The layout and structure layers of docs/archive/pre-integration/DESIGN_DECISIONS.md "Map layers".
 * The layout is the stored map; structure is derived from it, when generating
 * and when reading an artifact back, and is never stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeGrid } from "../src/coding.ts";
import {
  DEFAULT_LIBRARY,
  deriveStructure,
  generateMap,
  libraryFingerprint,
} from "../src/core.ts";
import type { Library } from "../src/types.ts";

const small = { mode: "playground" as const, zoneWidth: 2, zoneHeight: 1 };

/** The class bindings sweep.mts uses, so builders lay material and segments. */
const builders = structuredClone(DEFAULT_LIBRARY);
for (const [cellClass, generator] of Object.entries({
  market: "compound",
  depot: "pillar-hall",
  landing: "rubble",
  evac: "compound",
  park: "courtyard",
}))
  builders.cellClasses![cellClass] = { generator };

test("structure is a function of the layout", () => {
  for (const [seed, library] of [
    ["layers-1", DEFAULT_LIBRARY],
    ["layers-2", builders],
  ] as const) {
    const m = generateMap(seed, small, library);
    const derived = deriveStructure(m.layout!, library);
    assert.ok(derived, "a generated layout has a structure");
    assert.deepStrictEqual(derived.structure, m.structure, seed);
    assert.deepStrictEqual(
      deriveStructure(m.layout!, library)!.structure,
      derived.structure,
      `${seed}, derived twice`,
    );
  }
});

test("layout and structure don't depend on which micro builders run", () => {
  // Builders write material and segments into the final grid. None of that
  // may reach the layout or the structure derived from it.
  const plain = generateMap("layers-3", small, DEFAULT_LIBRARY);
  const bound = generateMap("layers-3", small, builders);
  const { library: a, ...plainLayout } = plain.layout!;
  const { library: b, ...boundLayout } = bound.layout!;
  assert.notEqual(a, b, "the two libraries differ");
  assert.deepStrictEqual(boundLayout, plainLayout);
  assert.deepStrictEqual(bound.structure, plain.structure);
  assert.notDeepStrictEqual(
    bound.grid.segments.open,
    plain.grid.segments.open,
    "the builders did change the final grid",
  );
});

test("the layout keeps `any`; structure fills it from the neighbour's edge", () => {
  // A field that defers everywhere, and a market whose east edge demands market
  // of the cell beyond it.
  const library: Library = structuredClone(DEFAULT_LIBRARY);
  library.setPieces = [];
  library.tileSets = [];
  library.tiles = [
    { id: "field", defaultCellClass: "any", orientations: [0], weight: 3 },
    {
      id: "market-east",
      defaultCellClass: "market",
      orientations: [0],
      edges: { E: Array(6).fill("market") },
    },
  ];
  const m = generateMap("layers-any", small, library);
  const layoutClass = decodeGrid(m.layout!.grid.cells.class);
  const filled = decodeGrid(m.structure!.cells.class);
  const W = m.layout!.grid.width;
  let checked = 0;
  for (const tile of m.tiles.filter((t) => t.templateId === "market-east")) {
    const x = tile.x + m.params.tileSize;
    for (let i = 0; i < m.params.tileSize; i++) {
      const cell = (tile.y + i) * W + x;
      if (layoutClass[cell] !== "any") continue;
      assert.equal(filled[cell], "market", `cell ${cell} beside ${tile.id}`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, "some field sits east of a market");
  // A deferring cell no edge constrains is open ground.
  const loose = layoutClass.findIndex(
    (c, i) => c === "any" && filled[i] !== "market",
  );
  assert.ok(loose >= 0);
  assert.equal(filled[loose], "open");
});

test("seam constraints are segment-shaped", () => {
  const m = generateMap("layers-4", small);
  const { width: W, height: H } = m.layout!.grid;
  assert.equal(
    m.structure!.segments.constraints.count,
    (W + 1) * H + (H + 1) * W,
  );
  assert.equal(
    m.structure!.segments.constraints.count,
    m.layout!.grid.segments.open.count,
  );
  assert.equal(m.structure!.cells.class.count, W * H);
});

test("the layout names its library by content, not by key order", () => {
  const reordered = Object.fromEntries(
    Object.entries(structuredClone(DEFAULT_LIBRARY)).reverse(),
  ) as unknown as Library;
  assert.equal(libraryFingerprint(reordered), libraryFingerprint(DEFAULT_LIBRARY));
  assert.notEqual(libraryFingerprint(builders), libraryFingerprint(DEFAULT_LIBRARY));
});
