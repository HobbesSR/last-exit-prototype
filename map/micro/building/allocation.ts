import type { Cell } from '../../kernel/cell.ts';
import { CELL_SCALE } from '../../kernel/scale.ts';
import { canonicalCells, cellKey, connectedComponents } from '../decomposition/analysis.ts';
import { deriveBuildingBoundaries } from './boundaries.ts';
import type { BuildingBoundary } from './boundaries.ts';
import { OUTSIDE, validateBuildingDesign } from './design.ts';
import type { BuildingAllocation, BuildingConnection, BuildingDesign, BuildingSpace } from './design.ts';
import { placeBuildingOpenings } from './openings.ts';
import type { PlacedBuildingOpening } from './openings.ts';

export interface BuildingAllocationOptions {
  seed?: number;
  /** Explored trials plus evaluated cuts, so it bounds the work. Default 2000, at most 20000. */
  maxSteps?: number;
  /** Feasible complete partitions compared. Default 16, at most 128. */
  maxSolutions?: number;
}
/** `steps` counts explored trials and evaluated cuts; `cuts` is the evaluated-cut share of it. */
export interface BuildingAllocationSearch { steps: number; cuts: number; solutions: number; budgetExhausted: boolean; optimal: false }
export interface BuildingAllocationScores { connections: number; outside: number }
export type BuildingAllocationResult = {
  ok: true;
  allocation: BuildingAllocation;
  /** Realize this resolved design: spanning doors precede optional guidance. */
  design: BuildingDesign;
  /** Untrimmed placement for scoring; realizeBuilding owns option-dependent wall trims. */
  openings: PlacedBuildingOpening[];
  scoreComponents: BuildingAllocationScores;
  search: BuildingAllocationSearch;
} | { ok: false; reason: string; search: BuildingAllocationSearch };

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const samePair = (a: { a: string; b: string }, b: { a: string; b: string }) =>
  a.a === b.a && a.b === b.b || a.a === b.b && a.b === b.a;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
// Local deterministic tie ordering; never consumes a strategy's random stream.
function tie(seed: number, key: string): number {
  let value = 2166136261;
  for (const char of `${seed}:${key}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

/** Conservative room family: connected 3x3 patch centers, covering every cell. */
function usable(cells: Cell[]): boolean {
  const own = new Set(cells.map(cellKey)), centers: Cell[] = [], covered = new Set<string>();
  for (const c of cells) {
    const patch: string[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) patch.push(`${c.x + dx},${c.y + dy}`);
    if (patch.every(key => own.has(key))) { centers.push(c); for (const key of patch) covered.add(key); }
  }
  return covered.size === cells.length && connectedComponents(centers).length === 1;
}

/** A shared run must leave half a cell at each end of a two-cell opening. */
function joiningBoundaries(boundaries: BuildingBoundary[]): BuildingBoundary[] {
  return boundaries.filter(pair => pair.a !== OUTSIDE && pair.b !== OUTSIDE && pair.runs.some(run => run.length >= CELL_SCALE.doorway + 1));
}
function joined(ids: string[], boundaries: BuildingBoundary[]): boolean {
  const seen = new Set([ids[0]!]);
  for (let changed = true; changed;) {
    changed = false;
    for (const pair of joiningBoundaries(boundaries)) {
      if (seen.has(pair.a) === seen.has(pair.b)) continue;
      seen.add(pair.a); seen.add(pair.b); changed = true;
    }
  }
  return ids.every(id => seen.has(id));
}

/** Choose a spanning tree before windows or other optional connections can occupy its sites. */
function resolveDesign(design: BuildingDesign, boundaries: BuildingBoundary[], seed: number): BuildingDesign {
  const requested = [...design.connections].sort((a, b) => compareText(a.id, b.id));
  const preferred = (pair: BuildingBoundary) => requested.find(c => c.kind !== 'window' && samePair(c, pair));
  const edges = joiningBoundaries(boundaries).sort((a, b) => Number(!!preferred(b)) - Number(!!preferred(a))
    || tie(seed, JSON.stringify([a.a, a.b])) - tie(seed, JSON.stringify([b.a, b.b]))
    || compareText(JSON.stringify([a.a, a.b]), JSON.stringify([b.a, b.b])));
  const groups = new Map(design.spaces.map(space => [space.id, space.id]));
  const selected: BuildingConnection[] = [], usedIds = new Set(requested.map(c => c.id));
  for (const pair of edges) {
    const a = groups.get(pair.a)!, b = groups.get(pair.b)!;
    if (a === b) continue;
    let connection = preferred(pair);
    if (!connection) {
      let id = `allocation-door-${selected.length}`;
      while (usedIds.has(id)) id += '-';
      usedIds.add(id);
      connection = { id, a: pair.a, b: pair.b, kind: 'door' };
    }
    selected.push(connection);
    for (const [id, group] of groups) if (group === b) groups.set(id, a);
  }
  const selectedIds = new Set(selected.map(c => c.id));
  return structuredClone({ spaces: design.spaces, connections: [...selected, ...requested.filter(c => !selectedIds.has(c.id))] });
}

/**
 * Bounded seeded guillotine partitioning: split pending spaces into two groups
 * and recursively partition both sides of each cut. Failure is not proof that
 * no other partition exists.
 * Internal feasibility is pruned in this search; the caller owns the region promise.
 */
export function allocateBuilding(design: BuildingDesign, footprint: readonly Cell[], options: BuildingAllocationOptions = {}): BuildingAllocationResult {
  const search: BuildingAllocationSearch = { steps: 0, cuts: 0, solutions: 0, budgetExhausted: false, optimal: false };
  const fail = (reason: string): BuildingAllocationResult => ({ ok: false, reason, search: { ...search } });
  const seed = options.seed ?? 0, maxSteps = options.maxSteps ?? 2000, maxSolutions = options.maxSolutions ?? 16;
  if (!Number.isSafeInteger(seed) || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20000
    || !Number.isInteger(maxSolutions) || maxSolutions < 1 || maxSolutions > 128) return fail('Invalid seed or search bounds.');
  const issues = validateBuildingDesign(design);
  if (issues.length) return fail(issues.join(' '));
  if (design.spaces.length > 8) return fail('Building allocation supports at most 8 spaces.');
  let cells: Cell[];
  try { cells = canonicalCells(footprint); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  if (!cells.length || connectedComponents(cells).length !== 1) return fail('The footprint must be nonempty and connected.');
  if (Math.max(...cells.map(c => c.x)) - Math.min(...cells.map(c => c.x)) >= 24
    || Math.max(...cells.map(c => c.y)) - Math.min(...cells.map(c => c.y)) >= 24) return fail('A building footprint may span at most 24 cells per axis.');
  const spaces = [...design.spaces].sort((a, b) => compareText(a.id, b.id));
  const minArea = (space: BuildingSpace) => Math.max(9, space.area.min);
  if (spaces.some(s => s.area.max < minArea(s)) || sum(spaces.map(minArea)) > cells.length
    || sum(spaces.map(s => s.area.max)) < cells.length) return fail('Space area ranges cannot cover this footprint with usable spaces.');
  const feasibleCache = new Map<string, boolean>();
  const roomFits = (part: Cell[]) => {
    const key = part.map(cellKey).join(';');
    if (!feasibleCache.has(key)) feasibleCache.set(key, usable(part));
    return feasibleCache.get(key)!;
  };
  let best: Extract<BuildingAllocationResult, { ok: true }> | undefined;
  const stopped = () => {
    if (search.steps >= maxSteps || search.solutions >= maxSolutions) { search.budgetExhausted = true; return true; }
    return false;
  };
  const accept = (assigned: BuildingAllocation['spaces']) => {
    const allocation = { footprint: cells, spaces: [...assigned].sort((a, b) => compareText(a.id, b.id)) };
    const boundaries = deriveBuildingBoundaries(allocation);
    if (!joined(spaces.map(s => s.id), boundaries)) return;
    const resolved = resolveDesign({ spaces, connections: design.connections }, boundaries, seed);
    const { openings } = placeBuildingOpenings(resolved, boundaries);
    const placed = new Set(openings.map(o => o.connectionId));
    const scoreComponents = {
      connections: design.connections.filter(c => placed.has(c.id)).length,
      outside: sum(spaces.map(s => {
        const touches = boundaries.some(b => (b.a === s.id && b.b === OUTSIDE) || (b.b === s.id && b.a === OUTSIDE));
        return s.outside === 'prefer' ? Number(touches) : s.outside === 'avoid' ? Number(!touches) : 0;
      })),
    };
    search.solutions++;
    const score = sum(Object.values(scoreComponents));
    if (!best || score > sum(Object.values(best.scoreComponents)))
      best = { ok: true, allocation, design: resolved, openings, scoreComponents, search };
  };
  type Group = { cells: Cell[]; spaces: BuildingSpace[] };
  // Every open group owns a disjoint piece, so its whole boundary is an
  // optimistic interface until subsequent cuts determine the actual owners.
  const groupIds = Array.from({ length: spaces.length }, (_, i) => {
    let id = `@group-${i}`;
    while (spaces.some(s => s.id === id)) id += '-';
    return id;
  });
  const inspect = (groups: Group[], boundaries: BuildingBoundary[]) => {
    const owners = new Map(groups.flatMap((g, i) => g.spaces.map(s => [s.id, groupIds[i]!] as const)));
    let potential = 0, secured = 0;
    const requests = new Map<BuildingBoundary, { count: number; isolated: boolean }>();
    for (const connection of design.connections) {
      const a = owners.get(connection.a) ?? OUTSIDE, b = owners.get(connection.b) ?? OUTSIDE;
      if (a === b) { potential++; continue; }
      const pair = boundaries.find(pair => samePair(pair, { a, b }));
      if (!pair?.runs.some((run, i) => run.length >= CELL_SCALE.doorway + 1
        && (!connection.side || pair.runSides[i] === connection.side))) continue;
      const request = requests.get(pair) ?? { count: 0, isolated: false };
      request.count++;
      request.isolated ||= groups.some(g => g.spaces.length === 1 && (g.spaces[0]!.id === connection.a || g.spaces[0]!.id === connection.b));
      requests.set(pair, request);
    }
    for (const [pair, request] of requests) {
      // A long seam is not an unlimited supply of future room doorways. This
      // is a ranking estimate only, never a hard architectural constraint.
      const capacity = sum(pair.runs.map(run => Math.floor(run.length / (CELL_SCALE.doorway + 1))));
      const available = Math.min(request.count, capacity);
      potential += available;
      if (request.isolated) secured += available;
    }
    return { potential, secured };
  };
  const visit = (groups: Group[]): void => {
    if (stopped()) return;
    const index = groups.findIndex(g => g.spaces.length > 1);
    if (index < 0) {
      search.steps++;
      if (groups.every(g => roomFits(g.cells))) accept(groups.map(g => ({ id: g.spaces[0]!.id, cells: g.cells })));
      return;
    }
    const current = groups[index]!, pending = current.spaces, remaining = current.cells;
    type Trial = { groups: Group[]; key: string; distance: number; balance: number; potential: number; secured: number };
    const trials: Trial[] = [];
    const subsets = Array.from({ length: (1 << pending.length) - 2 }, (_, i) => {
      const mask = i + 1, left = pending.filter((_, bit) => mask & (1 << bit)), right = pending.filter((_, bit) => !(mask & (1 << bit)));
      return { mask, left, right, minLeft: sum(left.map(minArea)), maxLeft: sum(left.map(s => s.area.max)),
        minRight: sum(right.map(minArea)), maxRight: sum(right.map(s => s.area.max)) };
    });
    for (const axis of ['x', 'y'] as const) {
      const lo = Math.min(...remaining.map(c => c[axis])), hi = Math.max(...remaining.map(c => c[axis]));
      for (let cut = lo + 1; cut <= hi; cut++) {
        const left = remaining.filter(c => c[axis] < cut), right = remaining.filter(c => c[axis] >= cut);
        // Area sums are the cheap test. A cut that passes them pays a step before
        // the connectivity and boundary work, so maxSteps bounds that work too.
        const fitting = subsets.filter(subset => left.length >= subset.minLeft && left.length <= subset.maxLeft
          && right.length >= subset.minRight && right.length <= subset.maxRight);
        if (!fitting.length) continue;
        if (stopped()) return;
        search.steps++; search.cuts++;
        if (connectedComponents(left).length !== 1 || connectedComponents(right).length !== 1) continue;
        const geometry = [...groups.slice(0, index).map(g => g.cells), left, right, ...groups.slice(index + 1).map(g => g.cells)];
        const boundaries = deriveBuildingBoundaries({ footprint: cells, spaces: geometry.map((cells, i) => ({ id: groupIds[i]!, cells })) });
        if (!joined(geometry.map((_, i) => groupIds[i]!), boundaries)) continue;
        for (const subset of fitting) {
          const next = [...groups.slice(0, index), { cells: left, spaces: subset.left },
            { cells: right, spaces: subset.right }, ...groups.slice(index + 1)];
          const guidance = inspect(next, boundaries);
          const target = remaining.length * (subset.minLeft + subset.maxLeft)
            / (subset.minLeft + subset.maxLeft + subset.minRight + subset.maxRight);
          trials.push({ groups: next, key: JSON.stringify([axis, cut, subset.mask]), distance: Math.abs(left.length - target), balance: Math.abs(subset.left.length - subset.right.length), ...guidance });
        }
      }
    }
    trials.sort((a, b) => b.potential - a.potential || a.balance - b.balance || b.secured - a.secured || a.distance - b.distance
      || tie(seed, a.key) - tie(seed, b.key) || compareText(a.key, b.key));
    for (const trial of trials) {
      if (stopped()) return;
      search.steps++;
      if (trial.groups.some(g => g.spaces.length === 1 && !roomFits(g.cells))) continue;
      visit(trial.groups);
    }
  };
  visit([{ cells, spaces }]);
  return best ? { ...best, search: { ...search } } : fail(search.budgetExhausted ? 'Search budget exhausted without a feasible allocation.'
    : 'No feasible allocation in the guillotine search family.');
}
