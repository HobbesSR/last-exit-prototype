/** Experimental authoring contract; independent of the legacy library/artifact versions. */
import type {
  NavTarget,
  Orientation,
  Point,
  Span,
  MapRegion,
} from "./types.ts";

export interface MacroCell extends Point {
  /** Omission uses the structure's defaultCellClass. */
  class?: string;
}
/** Unit segment, addressed in structure-local cell coordinates. */
export interface MacroSegment {
  axis: "h" | "v";
  x: number;
  y: number;
  /** null = wall; [0,1] = explicitly clear. Omission of a segment defers. */
  open: Span;
}
export interface MacroCorridor {
  id: string;
  /** Exact polyline swept by a disc; preserved through all later passes. */
  points: Point[];
  radius: number;
}
export interface MacroRouteConstraint {
  id: string;
  from: Point;
  to: Point;
  radius: number;
  /** false requests a cut in the sampled navigation, not a proof of continuous disconnection. */
  connected: boolean;
}
export interface MacroStructure {
  version: 1;
  id: string;
  defaultCellClass: string;
  /** Explicit cells allow nonrectangular, disconnected and partial-tile footprints. */
  cells: MacroCell[];
  /** Only segments incident to an owned cell may be stated. No interior margin. */
  segments?: MacroSegment[];
  /** Named local points; markers never carve a door or grant traversal. */
  entrances?: Array<Point & { id: string }>;
  corridors?: MacroCorridor[];
  constraints?: MacroRouteConstraint[];
}
export interface MacroPlacement {
  id: string;
  structure: MacroStructure;
  /** Integer world-cell translation after rotation about local vertex (0,0). */
  origin: Point;
  orientation: Orientation;
}
export interface MacroCompositionInput {
  version: 1;
  seed: string;
  width: number;
  height: number;
  /** Explicit playable cell mask. Its exterior, unlike tile seams, is sealed. */
  mask: Point[];
  defaultCellClass: string;
  placements: MacroPlacement[];
}
export interface MacroComposition extends NavTarget {
  version: 1;
  seed: string;
  /** Resolved unit spans: vertical first, then horizontal (same indexing as PrimitiveGrid). */
  segmentOpen: Span[];
  /** World-space definitions retained for checks after geometry changes. */
  constraints: Array<MacroRouteConstraint & { placementId: string }>;
  /** Dense world-cell arrays; empty class denotes outside the mask. */
  cellClass: string[];
  /** True where the class is the reserved material class. */
  cellSolid: boolean[];
  cellOwner: Array<string | null>;
  regions: MapRegion[];
  entrances: Array<Point & { id: string; placementId: string }>;
  corridors: Array<MacroCorridor & { placementId: string }>;
  manifest: {
    placements: Array<{
      id: string;
      structureId: string;
      cells: number;
      segments: number;
    }>;
    constraints: Array<{ placementId: string; id: string; connected: boolean }>;
    corridorsChecked: number;
  };
}

/**
 * Result of rechecking a constructed composition's retained corridors and route
 * constraints against its current walls. `connected` is the observed sampled
 * result, not a proof that no continuous route exists.
 */
export interface MacroRouteCheck {
  valid: boolean;
  errors: string[];
  /** Corridors whose every segment passed; a partly blocked corridor is not counted. */
  corridorsChecked: number;
  /** One entry per constraint that had two occupiable endpoints. */
  constraints: Array<{ placementId: string; id: string; connected: boolean }>;
}
