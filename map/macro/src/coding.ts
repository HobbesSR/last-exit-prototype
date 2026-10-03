/**
 * The wire form's packing, shared by every saved object (53, "The wire form"): every
 * enumerated value goes once into a string table and travels as an integer, and every
 * bulk field is a column in the narrowest integer lane that holds it. Canonical JSON and
 * the library fingerprint name content whatever its key order.
 */

/** Every enumerated value goes once into a shared table and travels as an integer (53). */
export class Strings {
  private list: string[] = [];
  private index = new Map<string, number>();
  id(value: string): number {
    const existing = this.index.get(value);
    if (existing !== undefined) return existing;
    const next = this.list.length;
    this.index.set(value, next);
    this.list.push(value);
    return next;
  }
  optional(value: string | undefined): number {
    return value === undefined ? -1 : this.id(value);
  }
  get table(): string[] {
    return this.list;
  }
}

/**
 * A run of integers in the narrowest lane that holds it. `w` is the byte width,
 * so a reader can view the bytes correctly no matter which encoding carried
 * them; in JSON the values arrive as plain numbers and `w` is redundant.
 */
export interface PackedInts {
  w: number;
  v: Int8Array | Int16Array | Int32Array | Uint8Array | number[];
}

/** Most of a map is small numbers, so pick the lane each array actually needs. */
export function packInts(values: Iterable<number>): PackedInts {
  const list = Array.from(values);
  let min = 0,
    max = 0;
  for (const value of list) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min >= -128 && max <= 127) return { w: 1, v: Int8Array.from(list) };
  if (min >= -32768 && max <= 32767) return { w: 2, v: Int16Array.from(list) };
  return { w: 4, v: Int32Array.from(list) };
}
export function unpackInts(packed: PackedInts | undefined): Int32Array {
  if (!packed || packed.v === undefined)
    throw new Error("expected packed integer data");
  const value = packed.v;
  if (Array.isArray(value)) return Int32Array.from(value);
  if (value instanceof Uint8Array) {
    const buffer = copyBuffer(value);
    if (packed.w === 1) return Int32Array.from(new Int8Array(buffer));
    if (packed.w === 2) return Int32Array.from(new Int16Array(buffer));
    return new Int32Array(buffer);
  }
  return Int32Array.from(value as Int32Array);
}

export function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Typed arrays are binary in BSON and plain number arrays in JSON. */
export function widen(value: unknown): unknown {
  if (ArrayBuffer.isView(value))
    return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(widen);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, widen(inner)]),
    );
  return value;
}

/** JSON with sorted keys, so equal content gives equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(",")}}`;
}

/** 32-bit FNV-1a. */
function fnv1a(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Names a library by its content, whatever its key order. A layout names
 * designs by id and later stages read those designs, so a map records this and
 * is only read back with the library it names. Two FNV-1a passes, the second
 * seeded differently, make 64 bits.
 */
export function libraryFingerprint(library: object): string {
  const text = canonicalJson(library);
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return hex(fnv1a(text)) + hex(fnv1a(`#${text}`));
}
