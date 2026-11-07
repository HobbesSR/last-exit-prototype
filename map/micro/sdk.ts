/** Reusable preparation/geometry/placement tools. No catalogue, live game state or runtime ID allocator. */
export { createRegionMask, createFillMask, createAccessMask, capsule, elementShapes, createRegionRouteSearch, findRegionRoute, findRegionRoutes, shapesOverlap, shapesShareArea, travelClear, validShape } from './geometry.ts';
export { createRouteClearance } from './route-clearance.ts';
export { spreadPoints } from './placement.ts';
export { microMetrics } from './metrics.ts';
export { portalStands, validatePortalReach } from './portals.ts';
export type { PortalReachInput, PortalReachOptions, PortalReachResult, PortalJoin, PortalStands } from './portals.ts';
export { boundaryBoxFilter, boxesAgainstHints, clipHints, hintedCells, hintErrors, hintsOfStrength, hintStrength, portalMargin } from './hints.ts';
export type { CellBox, HintedRegion, HintStrength } from './hints.ts';
export { wallHints } from './hint-walls.ts';
export type { HintWallOptions, HintWalls } from './hint-walls.ts';
export { perimeterRuns, perimeterWalls, commitPerimeterWalls, reachPerimeter } from './perimeter-reach.ts';
export type { PerimeterEdges, PerimeterReachOptions, PerimeterWalls } from './perimeter-reach.ts';
export type { SpreadPointOptions, SpreadPointResult } from './placement.ts';
export type { Cell, Hint, HintStated, RegionMask, RegionRandom, BuiltRegion, Portal, RegionBrief } from './types.ts';
export { analyzeRegion, canonicalCells, cellKey, connectedComponents, findNeckCuts, growRegion, shortestCellPath } from './decomposition/analysis.ts';
export { WorkBudget, WorkBudgetExceededError, createWorkBudget, DEFAULT_WORK_LIMIT } from './decomposition/work-budget.ts';
export { createRegionContext } from './decomposition/context.ts';
export { DecompositionState, allocateCandidates, generatorFitness, measureState, scoreState } from './decomposition/allocation.ts';
export { buildInterfaces } from './decomposition/interfaces.ts';
export { validateDecompositionPlan } from './decomposition/validate.ts';
export type * from './decomposition/types.ts';
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
export { DEPOT_WAREHOUSE_APPEARANCE } from './strategies/depot.ts';
export {
  RETAIL_STOREFRONT_INTACT,
  RETAIL_STOREFRONT_WEATHERED,
  RETAIL_STOREFRONT_DAMAGED,
  RETAIL_STOREFRONT_PRESETS,
  selectStorefrontAppearance,
  createStorefrontAppearance,
} from './strategies/hut.ts';
export {
  MARKET_STALL_INTACT,
  MARKET_STALL_WEATHERED,
  MARKET_STALL_DAMAGED,
  MARKET_STALL_PRESETS,
  createMarketStallAppearance,
} from './strategies/market.ts';
export {
  COMPOUND_RESIDENTIAL_INTACT,
  COMPOUND_RESIDENTIAL_WEATHERED,
  COMPOUND_RESIDENTIAL_DAMAGED,
  COMPOUND_RESIDENTIAL_PRESETS,
  createCompoundAppearance,
} from './strategies/compound.ts';
export { PLANT_SHED_APPEARANCE } from './strategies/plant.ts';
export {
  CHECKPOINT_POST_INTACT,
  CHECKPOINT_POST_WEATHERED,
  CHECKPOINT_POST_DAMAGED,
  CHECKPOINT_POST_PRESETS,
  CHECKPOINT_POST_APPEARANCE,
  CHECKPOINT_BARRIER_APPEARANCE,
  createCheckpointPostAppearance,
} from './strategies/checkpoint.ts';
export {
  PARK_HEDGE_INTACT,
  PARK_HEDGE_WEATHERED,
  PARK_HEDGE_DAMAGED,
  PARK_HEDGE_PRESETS,
  PARK_TREE_APPEARANCE,
  PARK_PAVILION_INTACT,
  PARK_PAVILION_WEATHERED,
  PARK_PAVILION_DAMAGED,
  PARK_PAVILION_PRESETS,
  selectParkHedgeAppearance,
  createParkPavilionAppearance,
} from './strategies/park.ts';
export {
  RUIN_WALL_INTACT,
  RUIN_WALL_WEATHERED,
  RUIN_WALL_DAMAGED,
  FALLEN_SLAB_APPEARANCE,
  RUINS_BUILDING_INTACT,
  RUINS_BUILDING_WEATHERED,
  RUINS_BUILDING_DAMAGED,
  RUINS_BUILDING_PRESETS,
  selectRuinWallAppearance,
  createRuinAppearance,
} from './strategies/ruins.ts';
export {
  RUBBLE_DEBRIS_INTACT,
  RUBBLE_DEBRIS_WEATHERED,
  RUBBLE_DEBRIS_DAMAGED,
  selectRubbleDebrisAppearance,
} from './strategies/rubble.ts';
export {
  COVER_CRATE_APPEARANCE,
  COVER_BARRIER_APPEARANCE,
  COVER_CONTAINER_APPEARANCE,
  selectCoverPieceAppearance,
} from './strategies/cover.ts';
export {
  OPEN_PARCEL_INTACT,
  OPEN_PARCEL_WEATHERED,
  OPEN_PARCEL_DAMAGED,
  OPEN_PARCEL_PRESETS,
  createOpenParcelAppearance,
} from './strategies/open.ts';
export {
  HALL_BUILDING_INTACT,
  HALL_BUILDING_WEATHERED,
  HALL_BUILDING_DAMAGED,
  HALL_BUILDING_PRESETS,
  HALL_PILLAR_APPEARANCE,
  createHallAppearance,
} from './strategies/hall.ts';
export {
  ARRIVAL_PLAZA_INTACT,
  ARRIVAL_PLAZA_WEATHERED,
  ARRIVAL_PLAZA_DAMAGED,
  ARRIVAL_PLAZA_PRESETS,
  ARRIVAL_COVER_APPEARANCE,
  createArrivalFacilityAppearance,
} from './strategies/arrival.ts';
export {
  DEPARTURE_EXIT_INTACT,
  DEPARTURE_EXIT_WEATHERED,
  DEPARTURE_EXIT_DAMAGED,
  DEPARTURE_EXIT_PRESETS,
  DEPARTURE_CIVIC_COVER_APPEARANCE,
  DEPARTURE_HUNTER_RIG_APPEARANCE,
  createDepartureFacilityAppearance,
} from './strategies/departure.ts';
export {
  CHARGING_RIG_INTACT,
  CHARGING_RIG_WEATHERED,
  CHARGING_RIG_DAMAGED,
  CHARGING_RIG_PRESETS,
  CHARGING_GUARD_APPEARANCE,
  CHARGING_COVER_APPEARANCE,
  createChargingRigAppearance,
} from './strategies/charging.ts';
export {
  TRANSIT_STATION_INTACT,
  TRANSIT_STATION_WEATHERED,
  TRANSIT_STATION_DAMAGED,
  TRANSIT_STATION_PRESETS,
  TRANSIT_CIVIC_COVER_APPEARANCE,
  TRANSIT_WARP_GUARD_APPEARANCE,
  createTransitStationAppearance,
} from './strategies/transit.ts';

export type { BuildingAllocationOptions, BuildingAllocationResult, BuildingAllocationSearch, BuildingAllocationScores } from './building/allocation.ts';

export { inheritBriefMargins, validateFillConstraints } from './margins.ts';
export { prepareDelegation, prepareInitialPartition, patchFootprintKey, validateBriefPartition } from './delegation.ts';
export type { PatchOffer, PreparedPatch, PatchRejection, BriefCrossing, PreparedDelegation, PatchPreparationPolicy } from './delegation.ts';
export { createAddressedArea } from './addressed.ts';
export type { AddressedArea } from './addressed.ts';
export { createBuilderCanvas } from './canvas.ts';
export type { CanvasAssembly } from './canvas.ts';
export { createProspectiveParcels } from './prospective-parcels.ts';
export type { ProspectiveParcels, ParcelHandle, ParcelProposal, ParcelOptions, HandoffProposal } from './prospective-parcels.ts';
export { parcelArea, parcelCells, areaContains } from './parcel-area.ts';
export { discoverCordWitness } from './cord-witness.ts';
export type { CordWitness, CordEdge, CordCounters, CordBudget, CordWitnessResult } from './cord-witness.ts';
