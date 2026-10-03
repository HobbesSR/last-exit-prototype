/**
 * The in-house BSON codec (53, "BSON"), and the wire form's packing and fingerprint
 * (`coding.ts`) that every saved object shares.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeBson, encodeBson, looksLikeBson } from "../src/bson.ts";
import { canonicalJson, libraryFingerprint, packInts, unpackInts } from "../src/coding.ts";

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


test("BSON is told from JSON by its bytes", () => {
  assert.ok(looksLikeBson(encodeBson({ a: 1 })));
  assert.ok(!looksLikeBson(new TextEncoder().encode('{"a":1}')));
});

test("integers pack into the narrowest lane, and unpack from either encoding", () => {
  assert.equal(packInts([0, 127, -128]).w, 1);
  assert.equal(packInts([0, 300]).w, 2);
  assert.equal(packInts([70000]).w, 4);
  const packed = packInts([1, -2, 3000]);
  assert.deepEqual([...unpackInts(packed)], [1, -2, 3000]);
  // JSON carries plain numbers; BSON carries the lane's bytes.
  assert.deepEqual([...unpackInts({ w: packed.w, v: [...packed.v] })], [1, -2, 3000]);
  const bytes = new Uint8Array((packed.v as Int16Array).buffer);
  assert.deepEqual([...unpackInts({ w: packed.w, v: bytes })], [1, -2, 3000]);
  assert.throws(() => unpackInts(undefined), /expected packed integer data/);
});

test("content names itself whatever its key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2], c: undefined } }), '{"a":{"d":[2]},"b":1}');
  assert.equal(libraryFingerprint({ b: 1, a: 2 }), libraryFingerprint({ a: 2, b: 1 }));
  assert.notEqual(libraryFingerprint({ a: 1 }), libraryFingerprint({ a: 2 }));
  assert.match(libraryFingerprint({}), /^[0-9a-f]{16}$/);
});
