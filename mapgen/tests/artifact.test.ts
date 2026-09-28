import test from "node:test";
import assert from "node:assert/strict";
import { decodeBson, encodeBson, looksLikeBson } from "../src/bson.ts";
import {
  artifactToBson,
  artifactToJson,
  artifactFromBson,
  decodeArtifact,
  encodeArtifact,
  readArtifact,
  WIRE_VERSION,
} from "../src/artifact.ts";
import { DEFAULT_LIBRARY, generateMap, validateMap } from "../src/core.ts";
import { generatePlannedMap } from "../src/plan/compose.ts";

const NUL = String.fromCharCode(0);
const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

test("BSON matches the published example documents byte for byte", () => {
  // Both vectors come from bsonspec.org.
  assert.equal(
    hex(encodeBson({ hello: "world" })),
    "160000000268656c6c6f0006000000776f726c640000",
  );
  assert.equal(
    hex(encodeBson({ BSON: ["awesome", 5.05, 1986] })),
    "310000000442534f4e002600000002300008000000617765736f6d6500" +
      "0131003333333333331440103200c20700000000",
  );
});

test("BSON round-trips the value shapes an artifact uses", () => {
  const doc = {
    int: 42,
    negative: -7,
    big: 3_000_000_000,
    float: 0.25,
    text: "vault",
    flag: true,
    nothing: null,
    nested: { a: [1, 2, 3], b: { c: "d" } },
    binary: Int32Array.from([1, -2, 300000]),
  };
  const back = decodeBson(encodeBson(doc));
  assert.equal(back.int, 42);
  assert.equal(back.negative, -7);
  assert.equal(back.big, 3_000_000_000);
  assert.equal(back.float, 0.25);
  assert.equal(back.text, "vault");
  assert.equal(back.flag, true);
  assert.equal(back.nothing, null);
  assert.deepEqual(back.nested, { a: [1, 2, 3], b: { c: "d" } });
  // Typed arrays come back as bytes; the schema says how to read them.
  const bytes = back.binary as Uint8Array;
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(
    [...new Int32Array(bytes.buffer.slice(0, bytes.byteLength))],
    [1, -2, 300000],
  );
});

test("BSON rejects what it cannot represent", () => {
  assert.throws(() => encodeBson({ ["bad" + NUL + "key"]: 1 }));
  assert.throws(() => decodeBson(Uint8Array.from([1, 2, 3])));
  assert.throws(() => decodeBson(Uint8Array.from([5, 0, 0, 0, 9])));
});

test("enumerated values are interned once and stored as integers", () => {
  const m = generateMap("wire");
  const wire = encodeArtifact(m);
  // Every region class, template id and feature kind, once each. Seam kinds
  // are not among them: a seam is measured off the grid rather than stored.
  assert.ok(wire.strings.includes("market"));
  assert.ok(wire.strings.includes("street"));
  assert.equal(new Set(wire.strings).size, wire.strings.length);
  assert.ok(wire.strings.length < 64, "the table is a table, not the payload");

  // No enumerated name survives outside the table.
  const json = artifactToJson(m);
  const body = JSON.parse(json) as Record<string, unknown>;
  delete body.strings;
  delete body.seed;
  const rest = JSON.stringify(body);
  for (const name of ["market", "street", "market-front", "hunter-spawn"])
    assert.ok(!rest.includes(name), `${name} is still spelled out`);
});

test("the wire form drops what can be rebuilt", () => {
  const m = generateMap("wire");
  const wire = encodeArtifact(m) as unknown as Record<string, unknown>;
  // Geometry follows from the primitives; ids, positions and extents follow
  // from indices and the params.
  assert.equal(wire.walls, undefined);
  assert.equal(wire.edges, undefined);
  assert.equal(wire.tiles, undefined, "a V2 tile is its layout placement");
  // The final grid and regions follow from layout plus interiors.
  assert.equal(wire.grid, undefined);
  assert.equal(wire.regions, undefined);
  // And all of it comes back.
  const back = decodeArtifact(encodeArtifact(m));
  assert.deepEqual(back.walls, m.walls);
  assert.deepEqual(back.tiles, m.tiles);
  assert.deepEqual(back.edges, m.edges);
  assert.equal(back.regions[0]!.area, m.regions[0]!.area);
});

test("nothing derived from the layout is stored", () => {
  // docs/DESIGN_DECISIONS.md "Map layers": structure is derived on read.
  // tests/map-interiors.test.ts covers what's derived from layout plus interiors.
  const m = generateMap("wire");
  const wire = encodeArtifact(m) as unknown as Record<string, unknown>;
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
  for (const derived of [
    "structure",
    "constraints",
    "originalClass",
    "anchor",
    "anchors",
    "edges",
    "walls",
    "zones",
  ])
    assert.ok(!keys.has(derived), `${derived} is stored`);
  // Macro features are layout slots; only micro's own features are listed,
  // in the interiors.
  assert.equal(wire.features, undefined);
  const features = (wire.interiors as { features: unknown[] }).features;
  assert.equal(
    features.length,
    m.features.filter((f) => f.id.startsWith("micro-")).length,
  );
  // The layout's classes keep `any`: they are what the designs stated.
  const layout = wire.layout as { class: { palette: unknown } };
  const strings = wire.strings as string[];
  const palette = Array.from((layout.class.palette as { v: ArrayLike<number> }).v);
  assert.ok(palette.map((id) => strings[id]).includes("any"));
});

test("a map survives both encodings exactly and still validates", () => {
  for (const seed of ["alpha", "five", "wire"]) {
    const m = generateMap(seed, seed === "five" ? { exitCount: 5 } : {});
    const viaBson = artifactFromBson(artifactToBson(m));
    const viaJson = decodeArtifact(JSON.parse(artifactToJson(m)));
    assert.deepStrictEqual(viaBson, m, `${seed} through BSON`);
    assert.deepStrictEqual(viaJson, m, `${seed} through JSON`);
    assert.equal(validateMap(viaBson).valid, true);
  }
});

test("BSON is markedly smaller than the in-memory shape", () => {
  const m = generateMap("wire");
  const inMemory = JSON.stringify(m).length;
  const wireJson = artifactToJson(m).length;
  const bson = artifactToBson(m).length;
  assert.ok(wireJson < inMemory / 2, `${wireJson} vs ${inMemory}`);
  assert.ok(bson < wireJson, `${bson} vs ${wireJson}`);
  // Most of the BSON is binary payload rather than keys and punctuation, so it
  // stays a small multiple of the primitive count however large the map is.
  const primitives = m.grid.cells.class.count + m.grid.segments.open.count;
  assert.ok(bson < primitives * 1.5, `${bson} bytes for ${primitives}`);
});

test("readArtifact decides on the bytes, not on a file name", () => {
  const m = generateMap("wire");
  const bson = artifactToBson(m);
  const json = new TextEncoder().encode(artifactToJson(m));
  assert.ok(looksLikeBson(bson));
  assert.ok(!looksLikeBson(json));
  assert.deepStrictEqual(readArtifact(bson), m);
  assert.deepStrictEqual(readArtifact(json), m);
});

test("a foreign or future document is refused clearly", () => {
  assert.throws(
    () => decodeArtifact({ hello: "world" }),
    /not a last-exit-map/,
  );
  const m = generateMap("wire");
  const wire = encodeArtifact(m) as unknown as Record<string, unknown>;
  wire.wire = 99;
  assert.throws(() => decodeArtifact(wire), /unsupported wire version 99/);
});

test("a version-1 artifact is refused, naming the version", () => {
  // Version 1 stored the fused grid and anchors, not the layout. There is no
  // migration and no legacy reader.
  const m = generateMap("wire");
  const wire = encodeArtifact(m) as unknown as Record<string, unknown>;
  wire.wire = 1;
  assert.throws(
    () => decodeArtifact(wire),
    (error: Error) =>
      /wire version 1\b/.test(error.message) &&
      error.message.includes(`wire version ${WIRE_VERSION}`),
  );
});

test("a map is read with the library it was generated from, or refused", () => {
  const small = { mode: "playground" as const, zoneWidth: 2, zoneHeight: 1 };
  const other = structuredClone(DEFAULT_LIBRARY);
  other.cellClasses!.market = { generator: "compound" };
  const m = generateMap("library", small, other);
  const wire = JSON.parse(artifactToJson(m));
  assert.deepStrictEqual(decodeArtifact(wire, other), m);
  assert.throws(
    () => decodeArtifact(wire),
    /generated with a different library/,
    "the default library is not the one the layout names designs from",
  );
});

test("a planned map survives both encodings exactly", () => {
  // The planned path's layers are #50's; until then it keeps its own form.
  const m = generatePlannedMap("wire", { mode: "playground", zoneWidth: 4, zoneHeight: 2 });
  assert.deepStrictEqual(artifactFromBson(artifactToBson(m)), m);
  // This map has no tile-graph route, so its route metrics are Infinity, which
  // survives BSON but not JSON (docs/DESIGN_DECISIONS.md "BSON").
  const viaJson = decodeArtifact(JSON.parse(artifactToJson(m)));
  assert.deepStrictEqual(viaJson, {
    ...m,
    metrics: JSON.parse(JSON.stringify(m.metrics)),
  });
});
