import type { Cell } from './cell.ts';
import type { OwnerBoundary } from './run.ts';

/**
 * Worked cases of the run definition in run.ts. Every finder of runs, at either level,
 * is tested against these: `parts` in, exactly `boundaries` out. Parts are given as rows
 * of characters, one owner per letter and `.` for no owner, with row 0 at the top.
 */
export interface RunCase { name: string; rows: string[]; boundaries: OwnerBoundary[] }

export const RUN_CASES: readonly RunCase[] = [
  { name: 'a straight boundary is one run', rows: ['AB', 'AB', 'AB'],
    boundaries: [{ a: 'A', b: 'B', runs: [{ axis: 'v', x: 1, y: 0, length: 3 }] }] },
  { name: 'a corner splits a boundary into two runs', rows: ['AAB', 'AAB', 'BBB'],
    boundaries: [{ a: 'A', b: 'B', runs: [{ axis: 'h', x: 0, y: 2, length: 2 }, { axis: 'v', x: 2, y: 0, length: 2 }] }] },
  { name: 'a gap on one line splits it', rows: ['AB', 'A.', 'AB'],
    boundaries: [{ a: 'A', b: 'B', runs: [{ axis: 'v', x: 1, y: 0, length: 1 }, { axis: 'v', x: 1, y: 2, length: 1 }] }] },
  { name: 'a change of owner across splits a straight line', rows: ['AAAA', 'BBCC'],
    boundaries: [
      { a: 'A', b: 'B', runs: [{ axis: 'h', x: 0, y: 1, length: 2 }] },
      { a: 'A', b: 'C', runs: [{ axis: 'h', x: 2, y: 1, length: 2 }] },
      { a: 'B', b: 'C', runs: [{ axis: 'v', x: 2, y: 1, length: 1 }] },
    ] },
  { name: 'edges facing no owner are not runs', rows: ['A.', '..'], boundaries: [] },
  { name: 'an enclosed owner has one run per side', rows: ['AAAA', 'ABBA', 'ABBA', 'AAAA'],
    boundaries: [{ a: 'A', b: 'B', runs: [
      { axis: 'h', x: 1, y: 1, length: 2 }, { axis: 'h', x: 1, y: 3, length: 2 },
      { axis: 'v', x: 1, y: 1, length: 2 }, { axis: 'v', x: 3, y: 1, length: 2 },
    ] }] },
  { name: 'a one-segment run is still a run', rows: ['AB', 'AA'],
    boundaries: [{ a: 'A', b: 'B', runs: [{ axis: 'h', x: 1, y: 1, length: 1 }, { axis: 'v', x: 1, y: 0, length: 1 }] }] },
];

/** A case's parts, in first-seen order of their letters. */
export function runCaseParts(runCase: RunCase): { id: string; cells: Cell[] }[] {
  const parts = new Map<string, Cell[]>();
  runCase.rows.forEach((row, y) => [...row].forEach((id, x) => {
    if (id === '.') return;
    if (!parts.has(id)) parts.set(id, []);
    parts.get(id)!.push({ x, y });
  }));
  return [...parts].map(([id, cells]) => ({ id, cells }));
}
