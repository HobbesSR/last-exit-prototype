/**
 * Dense primitive attributes as an interned palette plus run-length codes.
 *
 * Cells, segments and vertices are enumerated per tile, so a map holds tens of
 * thousands of each. Their metadata is overwhelmingly enumerated values drawn
 * from a small set — a cell class name, an open span, a height — and is
 * strongly coherent in space. Storing an array of objects spends most of its
 * bytes re-spelling the same key names and the same enum members; storing codes
 * into a palette, run-length encoded, spends almost none and still serializes
 * as plain readable JSON.
 *
 * A grid always covers `count` primitives exactly, so an index maps to a value
 * without consulting anything else.
 */

/** Run-length encoded codes into a palette: [length, code, length, code, …]. */
export interface CodedGrid<T = unknown> {
  palette: T[];
  runs: number[];
  count: number;
}

export function encodeGrid<T>(values: readonly T[]): CodedGrid<T> {
  const palette: T[] = [];
  // Primitive values key themselves; only structured values need serializing.
  const codes = new Map<unknown, number>();
  const runs: number[] = [];
  let previous = -1;
  let length = 0;
  for (const value of values) {
    const key =
      value !== null && typeof value === "object"
        ? JSON.stringify(value)
        : value;
    let code = codes.get(key);
    if (code === undefined) {
      code = palette.length;
      codes.set(key, code);
      palette.push(value);
    }
    if (code === previous) {
      length += 1;
      continue;
    }
    if (length) runs.push(length, previous);
    previous = code;
    length = 1;
  }
  if (length) runs.push(length, previous);
  return { palette, runs, count: values.length };
}

/** Fill a grid with one value; the cheap case, and the common one. */
export function uniformGrid<T>(value: T, count: number): CodedGrid<T> {
  return { palette: [value], runs: count ? [count, 0] : [], count };
}

export function decodeGrid<T>(grid: CodedGrid<T>): T[] {
  const out: T[] = new Array(grid.count);
  let at = 0;
  for (let i = 0; i + 1 < grid.runs.length; i += 2) {
    const length = grid.runs[i]!,
      value = grid.palette[grid.runs[i + 1]!]!;
    for (let k = 0; k < length; k++) out[at++] = value;
  }
  return out;
}

/**
 * A random-access reader. Sequential reads are the common pattern, so the
 * cursor is kept between calls and only rewinds when an index moves backwards.
 */
export function gridReader<T>(grid: CodedGrid<T>): (index: number) => T {
  let run = 0,
    start = 0;
  return (index: number): T => {
    if (index < start) {
      run = 0;
      start = 0;
    }
    while (run + 1 < grid.runs.length && index >= start + grid.runs[run]!) {
      start += grid.runs[run]!;
      run += 2;
    }
    return grid.palette[grid.runs[run + 1]!]!;
  };
}

export function validateGrid(
  grid: unknown,
  name: string,
  count: number,
): string[] {
  const errors: string[] = [];
  const value = grid as CodedGrid;
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.palette) ||
    !Array.isArray(value.runs) ||
    value.count !== count
  )
    return [`${name} must be a coded grid of ${count} entries`];
  if (value.runs.length % 2 !== 0) errors.push(`${name} has a truncated run`);
  let total = 0;
  for (let i = 0; i + 1 < value.runs.length; i += 2) {
    const length = value.runs[i]!,
      code = value.runs[i + 1]!;
    if (!Number.isInteger(length) || length < 1)
      errors.push(`${name} has an invalid run length`);
    if (!Number.isInteger(code) || code < 0 || code >= value.palette.length)
      errors.push(`${name} has a code outside its palette`);
    total += length;
  }
  if (total !== count)
    errors.push(`${name} covers ${total} entries, expected ${count}`);
  return errors;
}

// ── The wire form's packing, shared by every artifact ─────────────────────────

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
