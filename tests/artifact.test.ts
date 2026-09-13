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
} from "../src/artifact.ts";
import { generateMap, validateMap } from "../src/core.ts";

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
  assert.ok(wire.strings.includes("vault"));
  assert.ok(wire.strings.includes("plain"));
  assert.equal(new Set(wire.strings).size, wire.strings.length);
  assert.ok(wire.strings.length < 64, "the table is a table, not the payload");

  // No enumerated name survives outside the table.
  const json = artifactToJson(m);
  const body = JSON.parse(json) as Record<string, unknown>;
  delete body.strings;
  delete body.seed;
  const rest = JSON.stringify(body);
  for (const name of ["vault", "market", "pillar-hall", "hunter-spawn"])
    assert.ok(!rest.includes(name), `${name} is still spelled out`);
});

test("the wire form drops what can be rebuilt", () => {
  const m = generateMap("wire");
  const wire = encodeArtifact(m) as unknown as Record<string, unknown>;
  // Geometry follows from the primitives; ids and extents follow from indices.
  assert.equal(wire.walls, undefined);
  const tiles = wire.tiles as Record<string, unknown>;
  assert.equal(tiles.id, undefined);
  assert.equal(tiles.x, undefined);
  assert.equal(wire.edges, undefined);
  const regions = wire.regions as Record<string, unknown>;
  assert.equal(regions.id, undefined);
  assert.equal(regions.area, undefined);
  // And all of it comes back.
  const back = decodeArtifact(encodeArtifact(m));
  assert.deepEqual(back.walls, m.walls);
  assert.equal(back.tiles[0]!.id, m.tiles[0]!.id);
  assert.deepEqual(back.edges, m.edges);
  assert.equal(back.regions[0]!.area, m.regions[0]!.area);
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
  assert.throws(() => decodeArtifact(wire), /unsupported wire version/);
});
