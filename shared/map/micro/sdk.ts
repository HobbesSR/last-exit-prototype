/** Reusable geometry/placement tools. No catalogue, live game state, IDs or macro planner. */
export { createRegionMask, capsule, elementShapes, findRegionRoute, shapesOverlap, travelClear, validShape } from './geometry.ts';
export { spreadPoints } from './placement.ts';
export { microMetrics } from './metrics.ts';
export { resolveAccessRequirements, validateRegionAccess } from './access.ts';
export type { RegionAccessInput, RegionAccessResult } from './access.ts';
export { inheritBoundaryPorts, pairedBoundaryPort, validateBoundaryComposition } from './boundary.ts';
export type { RegionBoundary, ChildBoundary } from './boundary.ts';
export type { SpreadPointOptions, SpreadPointResult } from './placement.ts';
export type { BuilderContext, Cell, RegionBuilder, RegionMask, RegionRandom, RegionSpec, RegionResult } from './types.ts';
export { analyzeRegion, canonicalCells, cellKey, connectedComponents, findNeckCuts, growRegion, shortestCellPath } from './decomposition/analysis.ts';
export { createRegionContext } from './decomposition/context.ts';
export { DecompositionState, allocateCandidates, generatorFitness, measureState, scoreState } from './decomposition/allocation.ts';
export { buildInterfaces } from './decomposition/interfaces.ts';
export { validateDecompositionPlan } from './decomposition/validate.ts';
export type * from './decomposition/types.ts';
