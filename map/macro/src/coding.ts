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
