import { analyzeRegion, canonicalCells, cellKey, connectedComponents } from './analysis.ts';
import type { Cell } from '../types.ts';
import type { RegionAnalysis, RegionContext, RegionContextInput } from './types.ts';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

/** Immutable constraints and lazily cached measurements. Policy belongs to callers. */
export function createRegionContext(input: RegionContextInput): RegionContext {
  if (!input || typeof input.id !== 'string' || !input.id || input.id.length > 100) throw new Error('Region context needs a stable id.');
  if (!Number.isFinite(input.cellSize) || input.cellSize <= 0 || input.cellSize > 200) throw new Error('Invalid context cell scale.');
  const cells = canonicalCells(input.cells);
  if (!cells.length || connectedComponents(cells).length !== 1) throw new Error('Region context must be a connected nonempty polyomino.');
  const owned = new Set(cells.map(cellKey)), used = new Set<string>();
  const subset = (values: readonly Cell[] = []) => {
    const result = canonicalCells(values);
    if (result.some(c => !owned.has(cellKey(c)))) throw new Error('Constraint leaves the context region.');
    return result;
  };
  const reserved = subset(input.reserved), forbidden = subset(input.forbidden), required = subset(input.required);
  for (const c of [...reserved, ...forbidden, ...required]) {
    if (used.has(cellKey(c))) throw new Error('Reserved, forbidden and required cells must be disjoint.');
    used.add(cellKey(c));
  }
  const names = new Set<string>();
  const entrances = (input.entrances || []).map(e => {
    if (!e || !e.id || names.has(e.id) || !Number.isFinite(e.requiredWidth) || e.requiredWidth <= 0) throw new Error('Invalid entrance annotation.');
    names.add(e.id);
    const points = subset(e.cells);
    if (!points.length) throw new Error('Entrance annotation must name cells.');
    return { ...e, cells: points };
  });
  const snapshot = freeze(structuredClone({ ...input, cells, reserved, forbidden, required, entrances }));
  const cache = new Map<string, RegionAnalysis>();
  const context: RegionContext = {
    input: snapshot,
    analyze(footprint = cells) {
      const normalized = subset(footprint), key = normalized.map(cellKey).join(';');
      let analysis = cache.get(key);
      if (!analysis) {
        analysis = freeze(analyzeRegion(normalized));
        // Bound retained analysis memory; eviction affects only cost, never results.
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, analysis);
      }
      return analysis;
    },
    child(id, footprint) {
      const childCells = subset(footprint), keys = new Set(childCells.map(cellKey));
      const restrict = (values: readonly Cell[]) => values.filter(c => keys.has(cellKey(c)));
      return createRegionContext({ ...snapshot, id, cells: childCells, reserved: restrict(reserved), forbidden: restrict(forbidden), required: restrict(required),
        entrances: entrances.map(e => ({ ...e, cells: restrict(e.cells) })).filter(e => e.cells.length) });
    },
  };
  return Object.freeze(context);
}
