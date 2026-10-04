import { boundaryRuns } from '../../kernel/run.ts';
import type { Run } from '../../kernel/run.ts';
import type { Cell } from '../../kernel/cell.ts';
import { OUTSIDE } from './design.ts';
import type { BuildingAllocation, BuildingSide } from './design.ts';

export interface SpanStep { run: Run; forward: boolean }
/** A path between the same two owners. A ring has closed=true. */
export interface BuildingSpan { steps: SpanStep[]; closed: boolean }
export interface BuildingBoundary { a: string; b: string; runs: Run[]; runSides: (BuildingSide | null)[]; spans: BuildingSpan[] }

const key = (cell: Cell) => `${cell.x},${cell.y}`;
const point = (x: number, y: number) => `${x},${y}`;
function ends(run: Run): [string, string] {
  return [point(run.x, run.y), run.axis === 'h' ? point(run.x + run.length, run.y) : point(run.x, run.y + run.length)];
}

/** Chain straight runs. Junctions terminate paths; ties use kernel run order. */
function chain(runs: Run[]): BuildingSpan[] {
  const endpoints = runs.map(ends), at = new Map<string, number[]>();
  endpoints.forEach(([a, b], i) => {
    for (const p of [a, b]) { if (!at.has(p)) at.set(p, []); at.get(p)!.push(i); }
  });
  const used = new Set<number>(), spans: BuildingSpan[] = [];
  const walk = (start: number, origin: string) => {
    const steps: SpanStep[] = [];
    let index = start, from = origin, closed = false;
    while (!used.has(index)) {
      used.add(index);
      const [a, b] = endpoints[index]!;
      steps.push({ run: runs[index]!, forward: from === a });
      const to = from === a ? b : a;
      if (to === origin) { closed = true; break; }
      const incident = at.get(to)!;
      if (incident.length !== 2) break;
      const next = incident.find(i => !used.has(i));
      if (next === undefined) break;
      from = to; index = next;
    }
    spans.push({ steps, closed });
  };
  // Begin at open ends and junctions, then consume remaining rings.
  endpoints.forEach(([a, b], i) => {
    if (used.has(i)) return;
    if (at.get(a)!.length !== 2) walk(i, a);
    else if (at.get(b)!.length !== 2) walk(i, b);
  });
  endpoints.forEach(([a], i) => { if (!used.has(i)) walk(i, a); });
  return spans;
}

/** Add every missing cardinal neighbor as outside, so holes and concavities participate. */
export function deriveBuildingBoundaries(allocation: BuildingAllocation): BuildingBoundary[] {
  if (!allocation.footprint.length) throw new RangeError('Empty building footprint.');
  const footprint = new Set<string>();
  for (const c of allocation.footprint) {
    if (!Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y) || footprint.has(key(c))) throw new RangeError('Invalid or duplicate footprint cell.');
    footprint.add(key(c));
  }
  const assigned = new Set<string>(), ids = new Set<string>();
  for (const space of allocation.spaces) {
    if (!space.id || space.id === OUTSIDE || ids.has(space.id)) throw new RangeError(`Invalid allocation space id: ${space.id}`);
    ids.add(space.id);
    for (const c of space.cells) {
      if (!footprint.has(key(c)) || assigned.has(key(c))) throw new RangeError('Allocation overlaps or leaves its footprint.');
      assigned.add(key(c));
    }
  }
  if (assigned.size !== footprint.size) throw new RangeError('Allocation leaves footprint cells unassigned.');
  const outside = new Map<string, Cell>();
  for (const c of allocation.footprint) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const next = { x: c.x + dx, y: c.y + dy };
    if (!footprint.has(key(next))) outside.set(key(next), next);
  }
  return boundaryRuns([...allocation.spaces, { id: OUTSIDE, cells: [...outside.values()] }]).map(pair => {
    const runs: Run[] = [], runSides: (BuildingSide | null)[] = [];
    for (const run of pair.runs) {
      if (pair.a !== OUTSIDE && pair.b !== OUTSIDE) { runs.push(run); runSides.push(null); continue; }
      // The kernel groups by owner pair, irrespective of which side each owner occupies.
      // At diagonal touches that side can flip along one line: split before making walls.
      let start = 0;
      const sideAt = (i: number): BuildingSide => run.axis === 'h'
        ? footprint.has(point(run.x + i, run.y - 1)) ? 'S' : 'N'
        : footprint.has(point(run.x - 1, run.y + i)) ? 'E' : 'W';
      while (start < run.length) {
        const side = sideAt(start); let end = start + 1;
        while (end < run.length && sideAt(end) === side) end++;
        runs.push({ ...run, x: run.x + (run.axis === 'h' ? start : 0), y: run.y + (run.axis === 'v' ? start : 0), length: end - start });
        runSides.push(side); start = end;
      }
    }
    return { a: pair.a, b: pair.b, runs, runSides, spans: chain(runs) };
  });
}
