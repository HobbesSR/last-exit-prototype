/**
 * The interiors layer of docs/DESIGN_DECISIONS.md "Map layers". What micro
 * generation made is stored as its own section, stated over the layout and its
 * structure. The final grid, region partition and wall list are derived from
 * layout plus interiors, both when generating and when reading an artifact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeGrid } from "../src/coding.ts";
import {
  artifactFromBson,
  artifactToBson,
  artifactToJson,
  decodeArtifact,
  encodeArtifact,
} from "../src/artifact.ts";
import {
  DEFAULT_LIBRARY,
  cellsCrossed,
  generateMap,
  gridViews,
  validateMap,
  wallsFromLattice,
} from "../src/core.ts";
import type { GeneratedMap, Span } from "../src/types.ts";

/** The class bindings sweep.mts uses, so builders lay material, segments and props. */
const builders = structuredClone(DEFAULT_LIBRARY);
for (const [cellClass, generator] of Object.entries({
  market: "compound",
  depot: "pillar-hall",
  landing: "rubble",
  evac: "compound",
  park: "courtyard",
}))
  builders.cellClasses![cellClass] = { generator };

// Only the default size gives pillar-hall room to lay material.
const SEED = "micro-pipeline";
const built = generateMap(SEED, {}, builders);
const plain = generateMap(SEED, {}, DEFAULT_LIBRARY);

function interiorsOf(map: GeneratedMap) {
  assert.ok(map.interiors, "a V2 map has an interiors layer");
  return map.interiors;
}

test("the layout is untouched by micro", () => {
  const { library: a, ...boundLayout } = built.layout!;
  const { library: b, ...plainLayout } = plain.layout!;
  assert.notEqual(a, b, "the two libraries differ");
  assert.deepStrictEqual(boundLayout, plainLayout);
});

test("material is visible only through interiors", () => {
  const interiors = interiorsOf(built);
  const layoutClass = decodeGrid(built.layout!.grid.cells.class);
  const filled = decodeGrid(built.structure!.cells.class);
  assert.ok(!layoutClass.includes("solid"), "no layout cell is solid");
  assert.ok(!filled.includes("solid"), "no filled-in cell is solid");

  // Interiors state material where builders laid it and nothing elsewhere.
  const stated = decodeGrid(interiors.cells.class);
  assert.equal(stated.length, layoutClass.length);
  const views = gridViews(built);
  let solid = 0;
  stated.forEach((cellClass, i) => {
    if (cellClass === "any") {
      assert.equal(views.cellClass(i), filled[i], `cell ${i} keeps its filled-in class`);
      return;
    }
    assert.equal(views.cellClass(i), cellClass, `cell ${i} takes the class micro laid`);
    if (cellClass === "solid") solid += 1;
  });
  assert.ok(solid > 0, "the builders laid material on this seed");

  // The final regions include the material regions the builders laid.
  const material = built.regions.filter((r) => r.cellClass === "solid");
  assert.ok(material.length > 0);
  assert.equal(material.reduce((n, r) => n + r.cells.length, 0), solid);
});

test("micro's segments are a delta over the layout's", () => {
  const interiors = interiorsOf(built);
  const layoutOpen = decodeGrid(built.layout!.grid.segments.open);
  const stated = decodeGrid(interiors.segments.open);
  assert.equal(stated.length, layoutOpen.length);
  const views = gridViews(built);
  let changed = 0;
  stated.forEach((span, i) => {
    const expected = span === "any" ? layoutOpen[i] : span;
    assert.deepStrictEqual(views.segmentOpen(i), expected, `segment ${i}`);
    if (span !== "any") changed += 1;
  });
  assert.ok(changed > 0, "the builders stated segments on this seed");
  // The shipped library's open-field builder states nothing over the layout.
  const quiet = decodeGrid(interiorsOf(plain).segments.open);
  assert.ok(quiet.every((span) => span === "any"));
});

test("interiors and the final regions survive both encodings", () => {
  const interiors = interiorsOf(built);
  const viaJson = decodeArtifact(JSON.parse(artifactToJson(built)), builders);
  const viaBson = artifactFromBson(artifactToBson(built), builders);
  for (const [name, back] of [
    ["JSON", viaJson],
    ["BSON", viaBson],
  ] as const) {
    assert.deepStrictEqual(back.interiors, interiors, `interiors through ${name}`);
    assert.deepStrictEqual(back.regions, built.regions, `final regions through ${name}`);
    assert.deepStrictEqual(back.grid, built.grid, `final grid through ${name}`);
  }
});

test("a micro feature keeps its whole contract through both encodings", () => {
  // Builders only site kind and position today, but the interiors type admits
  // a feature's set piece and tiles, and the codec must carry them.
  const m = structuredClone(built);
  const [a, b] = m.tiles;
  const feature = {
    id: "micro-set-piece-99",
    kind: "set-piece" as const,
    x: a!.anchor.x,
    y: a!.anchor.y,
    setPieceId: "market-arcade",
    tileIds: [a!.id, b!.id],
  };
  m.interiors!.features.push(feature);
  m.features.push({ ...feature, tileId: a!.id });
  for (const [name, back] of [
    ["JSON", decodeArtifact(JSON.parse(artifactToJson(m)), builders)],
    ["BSON", artifactFromBson(artifactToBson(m), builders)],
  ] as const) {
    assert.deepStrictEqual(back.interiors!.features.at(-1), feature, `interiors through ${name}`);
    assert.deepStrictEqual(back.features.at(-1), m.features.at(-1), `view through ${name}`);
  }
});

test("nothing derived from layout plus interiors is stored", () => {
  const wire = encodeArtifact(built) as unknown as Record<string, unknown>;
  assert.ok(wire.interiors, "interiors are their own section");
  // The final grid and region partition are rebuilt on read.
  assert.equal(wire.grid, undefined, "the fused final grid is stored");
  assert.equal(wire.regions, undefined, "the final region partition is stored");
  const keys = new Set<string>();
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
    if (Array.isArray(value)) return value.forEach(walk);
    for (const [key, inner] of Object.entries(value)) {
      keys.add(key);
      walk(inner);
    }
  };
  walk(wire);
  for (const derived of ["cells", "cellOffsets", "area"])
    assert.ok(!keys.has(derived), `${derived} is stored`);
});

test("every prop stays inside the final region its manifest names", () => {
  const interiors = interiorsOf(built);
  const byId = new Map(built.regions.map((r) => [r.id, r]));
  assert.equal(interiors.regions.length, built.regions.length, "one entry per final region");
  let props = 0;
  for (const entry of interiors.regions) {
    const region = byId.get(entry.region);
    assert.ok(region, `${entry.region} is a final region`);
    assert.deepStrictEqual(region.manifest, entry.manifest);
    assert.deepStrictEqual(region.obstacles, entry.props);
    assert.equal(entry.manifest.obstaclesPlaced, entry.props.length);
    const own = new Set(region.cells);
    for (const prop of entry.props) {
      props += 1;
      for (const [cx, cy] of cellsCrossed(prop.x1, prop.y1, prop.x2, prop.y2))
        assert.ok(own.has(cy * built.grid.width + cx), `a prop of ${entry.region} leaves it`);
    }
  }
  assert.ok(props > 0, "the builders placed props on this seed");
});

test("validation reads the interiors' own naming of regions", () => {
  const interiors = interiorsOf(built);
  const from = interiors.regions.findIndex((entry) => entry.props.length > 0);
  assert.ok(from >= 0);
  const to = interiors.regions.findIndex(
    (entry, i) => i !== from && entry.manifest.obstaclesPlaced === 0 && entry.props.length === 0,
  );
  assert.ok(to >= 0);
  // Hand one region's props and count to another in interiors alone.
  const moved = structuredClone(built);
  const source = moved.interiors!.regions[from]!;
  const target = moved.interiors!.regions[to]!;
  target.props = source.props;
  target.manifest = { ...target.manifest, obstaclesPlaced: source.props.length };
  source.props = [];
  source.manifest = { ...source.manifest, obstaclesPlaced: 0 };
  const result = validateMap(moved);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.includes(target.region) && e.includes("outside")),
    result.errors.join("; "),
  );
});

test("the final wall list is the lattice over layout plus interiors, plus props", () => {
  const interiors = interiorsOf(built);
  const W = built.layout!.grid.width,
    H = built.layout!.grid.height;
  const filled = decodeGrid(built.structure!.cells.class);
  const statedClass = decodeGrid(interiors.cells.class);
  const layoutOpen = decodeGrid(built.layout!.grid.segments.open);
  const statedOpen = decodeGrid(interiors.segments.open);
  const segmentIndex = (vertical: boolean, line: number, offset: number) =>
    vertical ? offset * (W + 1) + line : (W + 1) * H + line * W + offset;

  const layoutOnly = wallsFromLattice(
    W,
    H,
    (i) => filled[i]!,
    (v, l, o) => layoutOpen[segmentIndex(v, l, o)]!,
  );
  const lattice = wallsFromLattice(
    W,
    H,
    (i) => (statedClass[i] === "any" ? filled[i]! : statedClass[i]!),
    (v, l, o) => {
      const i = segmentIndex(v, l, o);
      return (statedOpen[i] === "any" ? layoutOpen[i] : statedOpen[i]) as Span;
    },
  );
  const expected = [...lattice, ...interiors.regions.flatMap((entry) => entry.props)];
  assert.deepStrictEqual(built.walls, expected);
  assert.notDeepStrictEqual(lattice, layoutOnly, "interiors changed the lattice walls");
  const back = decodeArtifact(JSON.parse(artifactToJson(built)), builders);
  assert.deepStrictEqual(back.walls, expected, "a decoded map derives the same list");
});
