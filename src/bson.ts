/**
 * A minimal BSON reader and writer, covering the subset this project emits.
 *
 * BSON is used for one property in particular: it can carry raw binary, so the
 * packed numeric arrays that make up most of a map travel as bytes rather than
 * as text. That matters more than it might seem, because BSON encodes an array
 * as a document whose keys are "0", "1", "2", …; a 47,000-entry array would
 * spend most of its bytes on key names. Every bulk array is therefore a typed
 * array, which this writer stores as a binary element.
 *
 * Supported: double, string, document, array, binary (subtype 0), boolean,
 * null, int32. Integers outside int32 are written as doubles, which is exact
 * for every value this project produces.
 */

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
if (!LITTLE_ENDIAN)
  throw new Error("BSON support assumes a little-endian platform");

const DOUBLE = 0x01,
  STRING = 0x02,
  DOCUMENT = 0x03,
  ARRAY = 0x04,
  BINARY = 0x05,
  BOOLEAN = 0x08,
  NULL = 0x0a,
  INT32 = 0x10,
  INT64 = 0x12;

export type BsonValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | ArrayBufferView
  | BsonValue[]
  | { [key: string]: BsonValue };

class Writer {
  private bytes = new Uint8Array(1024);
  private at = 0;

  private room(extra: number): void {
    if (this.at + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.at + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.at));
    this.bytes = next;
  }
  byte(value: number): void {
    this.room(1);
    this.bytes[this.at++] = value;
  }
  int32(value: number): void {
    this.room(4);
    new DataView(this.bytes.buffer).setInt32(this.at, value, true);
    this.at += 4;
  }
  double(value: number): void {
    this.room(8);
    new DataView(this.bytes.buffer).setFloat64(this.at, value, true);
    this.at += 8;
  }
  raw(value: Uint8Array): void {
    this.room(value.length);
    this.bytes.set(value, this.at);
    this.at += value.length;
  }
  cstring(value: string): void {
    const encoded = new TextEncoder().encode(value);
    if (encoded.includes(0)) throw new Error("BSON keys may not contain NUL");
    this.raw(encoded);
    this.byte(0);
  }
  string(value: string): void {
    const encoded = new TextEncoder().encode(value);
    this.int32(encoded.length + 1);
    this.raw(encoded);
    this.byte(0);
  }
  /** Reserve a length slot and return a patch function for it. */
  placeholder(): () => void {
    const start = this.at;
    this.int32(0);
    return () => {
      new DataView(this.bytes.buffer).setInt32(start, this.at - start, true);
    };
  }
  get length(): number {
    return this.at;
  }
  finish(): Uint8Array {
    return this.bytes.slice(0, this.at);
  }
}

function isView(value: unknown): value is ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function writeElement(w: Writer, key: string, value: BsonValue): void {
  if (value === null || value === undefined) {
    w.byte(NULL);
    w.cstring(key);
    return;
  }
  if (typeof value === "boolean") {
    w.byte(BOOLEAN);
    w.cstring(key);
    w.byte(value ? 1 : 0);
    return;
  }
  if (typeof value === "number") {
    if (
      Number.isInteger(value) &&
      value >= -2147483648 &&
      value <= 2147483647
    ) {
      w.byte(INT32);
      w.cstring(key);
      w.int32(value);
    } else {
      w.byte(DOUBLE);
      w.cstring(key);
      w.double(value);
    }
    return;
  }
  if (typeof value === "string") {
    w.byte(STRING);
    w.cstring(key);
    w.string(value);
    return;
  }
  if (isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    w.byte(BINARY);
    w.cstring(key);
    w.int32(bytes.length);
    w.byte(0);
    w.raw(bytes);
    return;
  }
  if (Array.isArray(value)) {
    w.byte(ARRAY);
    w.cstring(key);
    writeDocument(w, Object.fromEntries(value.map((v, i) => [String(i), v])));
    return;
  }
  w.byte(DOCUMENT);
  w.cstring(key);
  writeDocument(w, value as Record<string, BsonValue>);
}

function writeDocument(w: Writer, doc: Record<string, BsonValue>): void {
  const patch = w.placeholder();
  for (const [key, value] of Object.entries(doc))
    if (value !== undefined) writeElement(w, key, value);
  w.byte(0);
  patch();
}

export function encodeBson(doc: Record<string, BsonValue>): Uint8Array {
  const w = new Writer();
  writeDocument(w, doc);
  return w.finish();
}

interface Reader {
  bytes: Uint8Array;
  view: DataView;
  at: number;
}
function readCString(r: Reader): string {
  const start = r.at;
  while (r.bytes[r.at] !== 0) {
    if (r.at >= r.bytes.length) throw new Error("BSON: unterminated key");
    r.at += 1;
  }
  const text = new TextDecoder().decode(r.bytes.subarray(start, r.at));
  r.at += 1;
  return text;
}
function readDocument(r: Reader): Record<string, BsonValue> {
  const start = r.at;
  const length = r.view.getInt32(r.at, true);
  if (length < 5 || start + length > r.bytes.length)
    throw new Error("BSON: bad document length");
  r.at += 4;
  const doc: Record<string, BsonValue> = {};
  while (r.at < start + length - 1) {
    const type = r.bytes[r.at++]!;
    const key = readCString(r);
    doc[key] = readValue(r, type);
  }
  if (r.bytes[r.at] !== 0) throw new Error("BSON: document not terminated");
  r.at += 1;
  return doc;
}
function readValue(r: Reader, type: number): BsonValue {
  switch (type) {
    case DOUBLE: {
      const value = r.view.getFloat64(r.at, true);
      r.at += 8;
      return value;
    }
    case INT32: {
      const value = r.view.getInt32(r.at, true);
      r.at += 4;
      return value;
    }
    case INT64: {
      const value = Number(r.view.getBigInt64(r.at, true));
      r.at += 8;
      return value;
    }
    case STRING: {
      const length = r.view.getInt32(r.at, true);
      r.at += 4;
      const text = new TextDecoder().decode(
        r.bytes.subarray(r.at, r.at + length - 1),
      );
      r.at += length;
      return text;
    }
    case BOOLEAN:
      return r.bytes[r.at++] === 1;
    case NULL:
      return null;
    case BINARY: {
      const length = r.view.getInt32(r.at, true);
      r.at += 4;
      const subtype = r.bytes[r.at++]!;
      if (subtype !== 0) throw new Error(`BSON: binary subtype ${subtype}`);
      const slice = r.bytes.slice(r.at, r.at + length);
      r.at += length;
      return slice;
    }
    case DOCUMENT:
      return readDocument(r);
    case ARRAY: {
      const doc = readDocument(r);
      return Object.keys(doc)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => doc[key]!);
    }
    default:
      throw new Error(`BSON: unsupported element type 0x${type.toString(16)}`);
  }
}

export function decodeBson(bytes: Uint8Array): Record<string, BsonValue> {
  const r: Reader = {
    bytes,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    at: 0,
  };
  return readDocument(r);
}

/** Does this look like a BSON document of exactly this many bytes? */
export function looksLikeBson(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return (
    view.getInt32(0, true) === bytes.length && bytes[bytes.length - 1] === 0
  );
}
