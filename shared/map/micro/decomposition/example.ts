import { createRegionContext } from './context.ts';
import { allocateCandidates } from './allocation.ts';
import { cellKey, connectedComponents, findNeckCuts, growRegion } from './analysis.ts';
import type { Cell } from '../types.ts';
import type { AllocationPolicy, CandidatePiece, GeneratorContract, RegionContextInput } from './types.ts';

/** Demonstration policy. These preferences are intentionally outside the SDK machinery. */
export const EXAMPLE_GENERATORS: GeneratorContract[] = [
  { id: 'rectangular-room', roles: ['room'], tags: ['interior'], minArea: 20, maxArea: 180, holes: 'none', rectangular: true,
    feasible: a => Math.min(a.bounds.w, a.bounds.h) < 3 ? ['Room must span at least three cells on both axes.'] : [],
    utility: a => ({ roomArea: a.area * 1.5 }) },
  { id: 'courtyard-ring', roles: ['courtyard'], tags: ['loop', 'outdoor'], minArea: 30, maxArea: 4096, holes: 'one',
    utility: a => ({ ringArea: a.area * 1.6, preservedHole: 20 }) },
  { id: 'generic-lobe', roles: ['lobe', 'utility'], tags: ['irregular'], minArea: 12, maxArea: 4096, holes: 'any',
    utility: a => ({ usableArea: a.area * .65 }) },
  { id: 'circulation-strip', roles: ['corridor'], tags: ['circulation'], minArea: 2, maxArea: 64, holes: 'none',
    feasible: a => a.localWidth.some(c => c.width < 2) ? ['Circulation strip contains one-cell widths.'] : [],
    utility: a => ({ circulationArea: a.area * 1.1 }) },
];

export function decompositionExample(shape: 'neck' | 'ring' | 'l' | 'rectangle' = 'neck'): RegionContextInput {
  if (!['neck', 'ring', 'l', 'rectangle'].includes(shape)) throw new Error('Unknown decomposition example.');
  const cells: Cell[] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 24; x++) {
    const included = shape === 'rectangle' ? x < 20 && y < 14
      : shape === 'l' ? x < 9 || y >= 9
      : shape === 'ring' ? x < 21 && y < 15 && !(x >= 6 && x < 15 && y >= 4 && y < 11)
      : y < 12 && (x < 10 || x >= 14 || y >= 5 && y < 8);
    if (included) cells.push({ x, y });
  }
  return { id: `example-${shape}`, cells, cellSize: 40, annotations: { purpose: 'Inspect candidate allocation; no physical micro geometry emitted.' } };
}

export function planExample(input: RegionContextInput, options: { beamWidth?: number; residualComponentPenalty?: number; piecePenalty?: number } = {}) {
  const context = createRegionContext(input), unavailable = new Set([...(input.reserved || []), ...(input.forbidden || [])].map(cellKey));
  const available = input.cells.filter(c => !unavailable.has(cellKey(c))), components = connectedComponents(available);
  const candidates: CandidatePiece[] = [], cuts = findNeckCuts(available, { maxWidth: 3, minComponentArea: 16, limit: 4 });
  const add = (id: string, cells: Cell[], role: string, rationale: string, cutId?: string) => {
    candidates.push({ id, cells, role, rationale, ...(cutId ? { cutId } : {}) });
  };
  for (const [i, component] of components.entries()) {
    const analysis = context.analyze(component);
    add(`whole:${i}:utility`, component, 'utility', 'Generic generator can preserve an irregular connected allocation.');
    // A generator proposes a hole-preserving claim before any rectangle partition is imposed.
    add(`whole:${i}:courtyard`, component, 'courtyard', 'Courtyard generator tests whether the intact footprint contains exactly one hole.');
    for (const [j, rectangle] of analysis.maximalRectangles.slice(0, 12).entries()) {
      const cells = component.filter(c => c.x >= rectangle.x && c.x < rectangle.x + rectangle.w && c.y >= rectangle.y && c.y < rectangle.y + rectangle.h);
      add(`rectangle:${i}:${String(j).padStart(2, '0')}`, cells, 'room', 'Maximal rectangle offered to a rectangular room consumer.');
      const claimed = new Set(cells.map(cellKey));
      for (const [k, remainder] of connectedComponents(component.filter(c => !claimed.has(cellKey(c)))).entries()) {
        add(`remainder:${i}:${j}:${k}:utility`, remainder, 'utility', 'Connected remainder of a rectangle proposal offered to a generic consumer.');
        add(`remainder:${i}:${j}:${k}:room`, remainder, 'room', 'A residual may itself be a useful room, subject to the same hard contract.');
      }
    }
  }
  for (const [i, cut] of cuts.entries()) {
    const widths = new Map(context.analyze(available).localWidth.map(v => [cellKey(v.cell), v.width]));
    const strip = growRegion(available, cut.cells, { maxArea: 64, eligible: cell => (widths.get(cellKey(cell)) || 0) <= 3 });
    add(`neck:${i}:strip`, strip, 'corridor', 'Grow from a separator through narrow cells to offer a connector allocation; cut cells are never deleted.', cut.id);
    for (const [j, lobe] of cut.components.entries()) {
      add(`neck:${i}:lobe:${j}`, lobe, 'lobe', 'Substantial component after a proposed neck cut.', cut.id);
      const analysis = context.analyze(lobe);
      for (const [k, r] of analysis.maximalRectangles.slice(0, 3).entries()) add(`neck:${i}:room:${j}:${k}`,
        lobe.filter(c => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h), 'room', 'Room footprint within a candidate lobe.', cut.id);
    }
  }
  // Equivalent claims from multiple proposal families need only one search slot.
  const seen = new Set<string>(), unique = candidates.filter(c => { const key = `${c.role}|${c.cells.map(cellKey).sort().join(';')}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const policy: AllocationPolicy = { beamWidth: options.beamWidth ?? 8, maxPieces: 6, maxCandidates: 64, unusedCellPenalty: .15,
    residualComponentPenalty: options.residualComponentPenalty ?? 10, smallResidualPenalty: 2, smallResidualArea: 8,
    piecePenalty: options.piecePenalty ?? 3, seamRunPenalty: .5, portalWidth: 2 };
  return allocateCandidates(context, unique, EXAMPLE_GENERATORS, policy, { strategy: 'rooms-courtyard-lobes-example', cuts });
}
