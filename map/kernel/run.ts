import type { Cell } from './cell.ts';

/**
 * A run: a maximal straight stretch of unit cell edges on one grid line, every edge of
 * which separates the same two owners (docs 51 stage 3). It ends at a corner, at a gap,
 * and wherever the owner across changes. Edges facing no owner are never part of a run.
 *
 * An `h` run lies on the horizontal line `y`, between rows `y - 1` and `y`, and covers
 * columns `x` to `x + length - 1`. A `v` run lies on the vertical line `x`, between
 * columns `x - 1` and `x`, and covers rows `y` to `y + length - 1`.
 *
 * Macro's boundaries between layout regions and the SDK's interfaces between a region's
 * children are both runs. Each level finds them its own way, and `RUN_CASES` pins that
 * they agree.
 */
export interface Run { axis: 'h' | 'v'; x: number; y: number; length: number }
/** Every run between one pair of owners, with `a` before `b`. */
export interface OwnerBoundary { a: string; b: string; runs: Run[] }

/**
 * The reference finder. Pairs are ordered by `a` then `b`, and each pair's runs by axis,
 * then `y`, then `x`.
 */
export function boundaryRuns(parts: readonly { id: string; cells: readonly Cell[] }[]): OwnerBoundary[] {
  const owners = new Map<string, string>(), ids = new Set<string>(), key = (x: number, y: number) => `${x},${y}`;
  for (const part of parts) {
    if (!part.id || ids.has(part.id)) throw new Error('Interface owners need unique identities.');
    ids.add(part.id);
    for (const cell of part.cells) {
      const k = key(cell.x, cell.y);
      if (owners.has(k)) throw new Error('Interface ownership overlaps.');
      owners.set(k, part.id);
    }
  }
  const pairs = new Map<string, { a: string; b: string; lines: Map<string, { axis: 'h' | 'v'; line: number; positions: number[] }> }>();
  for (const part of parts) for (const c of part.cells) for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
    const other = owners.get(key(c.x + dx, c.y + dy));
    if (!other || other === part.id) continue;
    const [a, b] = [part.id, other].sort() as [string, string], pairKey = JSON.stringify([a, b]);
    if (!pairs.has(pairKey)) pairs.set(pairKey, { a, b, lines: new Map() });
    const axis = dx ? 'v' : 'h', line = dx ? c.x + 1 : c.y + 1, lineKey = `${axis}:${line}`, lines = pairs.get(pairKey)!.lines;
    if (!lines.has(lineKey)) lines.set(lineKey, { axis, line, positions: [] });
    lines.get(lineKey)!.positions.push(dx ? c.y : c.x);
  }
  return [...pairs.values()].sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b)).map(({ a, b, lines }) => {
    const runs: Run[] = [];
    for (const { axis, line, positions } of lines.values()) {
      positions.sort((p, q) => p - q);
      for (let i = 0; i < positions.length;) {
        const start = positions[i]!; let length = 1; i++;
        while (i < positions.length && positions[i] === start + length) { length++; i++; }
        runs.push({ axis, x: axis === 'h' ? start : line, y: axis === 'h' ? line : start, length });
      }
    }
    runs.sort((p, q) => p.axis.localeCompare(q.axis) || p.y - q.y || p.x - q.x);
    return { a, b, runs };
  });
}
