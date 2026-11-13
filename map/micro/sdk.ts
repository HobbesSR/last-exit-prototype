/**
 * The builder-generation SDK (20.3, 20.9): the reusable utilities builders use during micro
 * generation. A name belongs here only if a builder could use it while building a region, as
 * mechanics rather than content. No catalogue (strategies and their appearance presets stay in
 * `strategies/`), no live game state, no runtime ID allocator, and no explorer or lab tooling
 * (`decomposition/` exports only what production allocation uses; labs import the rest there).
 */

// Masks, shapes and routes.
export { createRegionMask, createFillMask, createAccessMask, capsule, elementShapes, createRegionRouteSearch, findRegionRoute, findRegionRoutes, shapesOverlap, shapesShareArea, travelClear, validShape } from './geometry.ts';
export { createRouteClearance } from './route-clearance.ts';
export { microMetrics } from './metrics.ts';
export type { Cell, Hint, HintStated, RegionMask, RegionRandom, BuiltRegion, Portal, RegionBrief } from './types.ts';

// Placement.
export { spreadPoints } from './placement.ts';
export type { SpreadPointOptions, SpreadPointResult } from './placement.ts';

// Portals.
export { portalStands, validatePortalReach } from './portals.ts';
export type { PortalReachInput, PortalReachOptions, PortalReachResult, PortalJoin, PortalStands } from './portals.ts';

// Hints and perimeter walls.
export { boundaryBoxFilter, boxesAgainstHints, clipHints, hintedCells, hintErrors, hintsOfStrength, hintStrength, portalMargin } from './hints.ts';
export type { CellBox, HintedRegion, HintStrength } from './hints.ts';
export { perimeterRuns, perimeterWalls, commitPerimeterWalls, reachPerimeter } from './perimeter-reach.ts';
export type { PerimeterEdges, PerimeterReachOptions, PerimeterWalls } from './perimeter-reach.ts';

// Margins.
export { inheritBriefMargins, validateFillConstraints } from './margins.ts';

// Canvas and addressed intent.
export { createAddressedArea } from './addressed.ts';
export type { AddressedArea } from './addressed.ts';
export { createBuilderCanvas } from './canvas.ts';
export type { CanvasAssembly } from './canvas.ts';

// Cords and prospective parcels.
export { createProspectiveParcels } from './prospective-parcels.ts';
export type { ProspectiveParcels, ParcelHandle, ParcelProposal, ParcelOptions, HandoffProposal } from './prospective-parcels.ts';
export { parcelArea, parcelCells, areaContains } from './parcel-area.ts';
export { discoverCordWitness } from './cord-witness.ts';
export type { CordWitness, CordEdge, CordCounters, CordBudget, CordWitnessResult } from './cord-witness.ts';

// Delegation.
export { prepareDelegation, prepareInitialPartition, patchFootprintKey, validateBriefPartition } from './delegation.ts';
export type { PatchOffer, PreparedPatch, PatchRejection, BriefCrossing, PreparedDelegation, PatchPreparationPolicy } from './delegation.ts';

// Candidate allocation (the production subset of `decomposition/`).
export { canonicalCells, cellKey, connectedComponents } from './decomposition/analysis.ts';
export { WorkBudget, WorkBudgetExceededError } from './decomposition/work-budget.ts';
export { createRegionContext } from './decomposition/context.ts';
export { allocateCandidates } from './decomposition/allocation.ts';
export type { CandidatePiece, DecompositionPlan } from './decomposition/types.ts';

// Buildings.
export { emitWallRun } from './building/walls.ts';
export type { WallOpening, WallRunOptions } from './building/walls.ts';
export { OUTSIDE, validateBuildingDesign } from './building/design.ts';
export type { BuildingSpace, BuildingConnection, BuildingDesign, BuildingAllocation, BuildingSide, OpeningKind } from './building/design.ts';
export { deriveBuildingBoundaries } from './building/boundaries.ts';
export type { BuildingBoundary, BuildingSpan, SpanStep } from './building/boundaries.ts';
export { placeBuildingOpenings } from './building/openings.ts';
export type { PlacedBuildingOpening, MissedBuildingOpening, BuildingOpeningResult, BuildingOpeningOptions, BuildingRunLimits } from './building/openings.ts';
export { realizeBuilding } from './building/realize.ts';
export type { BuildingRealization, BuildingRealizationOptions } from './building/realize.ts';
export { splitBuilding } from './building/pieces.ts';
export type { BuildingPiece, BuildingPieceOptions } from './building/pieces.ts';
export { reachableRoofGroups } from './building/groups.ts';
export type { BuildingRoofGroups } from './building/groups.ts';
export type { BuildingObserver, BuildingTrace } from './building/trace.ts';
export { allocateBuilding } from './building/allocation.ts';
export type { BuildingAllocationOptions, BuildingAllocationResult, BuildingAllocationSearch, BuildingAllocationScores } from './building/allocation.ts';
