import { analyzeRegion, canonicalCells, cellKey, connectedComponents } from './analysis.ts';
import type { Cell } from '../types.ts';
import type { RegionAnalysis, RegionContext, RegionContextInput } from './types.ts';
import { WorkBudget } from './work-budget.ts';

export const REGION_CELL_SIZE_LIMIT = 200;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

/** Immutable constraints and lazily cached measurements. Policy belongs to callers. */
export function createRegionContext(input: RegionContextInput, budget: WorkBudget = new WorkBudget()): RegionContext {
  if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 100) throw new Error('Region context needs a stable id.');
  if (!Number.isFinite(input.cellSize) || input.cellSize <= 0 || input.cellSize > REGION_CELL_SIZE_LIMIT) throw new Error('Invalid context cell scale.');
  const cells = canonicalCells(input.cells, budget);
  if (!cells.length || connectedComponents(cells, budget).length !== 1) throw new Error('Region context must be a connected nonempty polyomino.');
  budget.spend(cells.length);
  const owned = new Set(cells.map(cellKey)), used = new Set<string>();
  const subset = (values: readonly Cell[] | undefined, work: WorkBudget) => {
    const result = canonicalCells(values === undefined ? [] : values, work);
    work.spend(result.length);
    if (result.some(c => !owned.has(cellKey(c)))) throw new Error('Constraint leaves the context region.');
    return result;
  };
  const reserved = subset(input.reserved, budget), forbidden = subset(input.forbidden, budget), required = subset(input.required, budget);
  budget.spend(reserved.length + forbidden.length + required.length + (input.entrances?.length || 0));
  for (const c of [...reserved, ...forbidden, ...required]) {
    if (used.has(cellKey(c))) throw new Error('Reserved, forbidden and required cells must be disjoint.');
    used.add(cellKey(c));
  }
  const names = new Set<string>();
  const entrances = (input.entrances || []).map(e => {
    if (!e || !e.id || names.has(e.id) || !Number.isFinite(e.requiredWidth) || e.requiredWidth <= 0) throw new Error('Invalid entrance annotation.');
    names.add(e.id);
    const points = subset(e.cells, budget);
    if (!points.length) throw new Error('Entrance annotation must name cells.');
    return { ...e, cells: points };
  });
  budget.spend(cells.length + reserved.length + forbidden.length + required.length + entrances.reduce((n, e) => n + e.cells.length, 0));
  const snapshot = freeze(structuredClone({ ...input, cells, reserved, forbidden, required, entrances }));
  const cache = new Map<string, { analysis: RegionAnalysis; work: number }>();
  const context: RegionContext = {
    input: snapshot,
    analyze(footprint = cells, work = new WorkBudget()) {
      const normalized = subset(footprint, work);
      work.spend(normalized.length);
      const key = normalized.map(cellKey).join(';');
      let entry = cache.get(key);
      if (!entry) {
        const before = work.used;
        const analysis = freeze(analyzeRegion(normalized, work));
        entry = { analysis, work: work.used - before };
        // Bound retained memory; eviction changes computation, never logical charges.
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, entry);
      } else {
        // Reproduce the exact refused charge for a small budget, so cache warmth
        // cannot change exhaustion diagnostics or the caller's consumed count.
        if (entry.work > work.limit - work.used) analyzeRegion(normalized, work);
        else work.spend(entry.work);
      }
      return entry.analysis;
    },
    child(id, footprint, work = new WorkBudget()) {
      const childCells = subset(footprint, work);
      work.spend(childCells.length);
      const keys = new Set(childCells.map(cellKey));
      const restrict = (values: readonly Cell[]) => { work.spend(values.length); return values.filter(c => keys.has(cellKey(c))); };
      return createRegionContext({ ...snapshot, id, cells: childCells, reserved: restrict(reserved), forbidden: restrict(forbidden), required: restrict(required),
        entrances: entrances.map(e => ({ ...e, cells: restrict(e.cells) })).filter(e => e.cells.length) }, work);
    },
  };
  return Object.freeze(context);
}
