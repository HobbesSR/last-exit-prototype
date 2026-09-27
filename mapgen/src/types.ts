/** Shared vocabulary for the authored library and the generated map artifact. */
import type { CodedGrid } from "./coding.ts";

export type Side = "N" | "E" | "S" | "W";
export type PortKind = "closed" | "door" | "wide" | "squeeze";
/** A seam contract a template accepts: "any", one kind, or "door|wide". */
export type PortValue = string | string[];
export type Orientation = 0 | 90 | 180 | 270;
export type Agent = "contestant" | "hunter";
/** Inclusive world-space box: [x0, y0, x1, y1]. */
export type Box = [number, number, number, number];

export interface Point {
  x: number;
  y: number;
}
export interface Wall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
/** An interior barrier, optionally split by a centered aperture. */
export interface InteriorWall extends Wall {
  gap?: number;
}

/**
 * A declared cell class, and what is intrinsic to it wherever it appears.
 * Anything that varies with position on the map belongs to the tier zone and
 * reaches a builder as a macro parameter instead.
 */
export interface CellClass {
  /** Chance that an unused slot gets a small collidable prop. */
  clutterChance?: number;
  /** Prop length in cells; must stay under 1 so a prop lives in one cell. */
  clutterSize?: number;
  /** If true, this class is a parameter placeholder (e.g. "floor") to be bound during macro placement. */
  parameter?: boolean;
  /**
   * Which region builder owns a region of this class, by catalogue id. Which
   * generator runs over an area is library data rather than code; an omitted or
   * unknown name falls back to the catalogue default.
   */
  generator?: string;
  /** Parameters passed through to that builder. Its own schema validates them. */
  generatorParams?: Record<string, number | string | boolean>;
}

/**
 * The open portion of a segment, in unit-local coordinates along it. `null` is
 * a full barrier and `[0, 1]` is fully clear. Authored wall endpoints are
 * integers and only `gap` introduces fractions, so a segment is never open in
 * two disjoint places.
 */
export type Span = [number, number] | null;
/**
 * What a template says about one segment. "any" is the deferring value: it
 * adopts whatever the seam contract and the neighbouring tile require.
 */
export type SegmentSpan = "any" | "open" | "wall" | [number, number];
export interface SegmentChannels {
  move?: SegmentSpan;
  sight?: SegmentSpan;
  shot?: SegmentSpan;
}
export type SegmentDeclaration = SegmentSpan | SegmentChannels;
/** What a template says about one vertex; "any" defers, as for segments. */
export interface VertexDeclaration {
  height?: number | "any";
  class?: string;
}
/** Explicit metadata for individual primitives, keyed by tile-local address. */
export interface PrimitiveOverrides {
  /** "col,row" */
  cells?: Record<string, { class?: string; height?: number }>;
  /** "v:x,row" for a vertical segment, "h:y,col" for a horizontal one. */
  segments?: Record<string, SegmentDeclaration>;
  /** "x,y" */
  vertices?: Record<string, VertexDeclaration>;
}

/**
 * One member of the tile corpus: a designed 6 x 6 patch of cells that the
 * assembler may place. It is not a starting point for making tiles; it is a
 * tile the map can use.
 */
export interface TileDesign {
  id: string;
  /** Class for cells this design does not paint. */
  defaultCellClass: string;
  orientations: Orientation[];
  /**
   * Coarse per-side seam classes, consumed by the tile-edge topology solver.
   * A hint layered over the design rather than part of it: what a side really
   * carries is stated by `edges` (segments) and `corners` (vertices). Omitted
   * sides defer, and a design may omit `ports` entirely.
   */
  ports?: Partial<Record<Side, PortValue>>;
  /** Explicit fallback role: true is used only when no ordinary design fits. Omission is false. */
  adapter?: boolean;
  weight?: number;
  /** Optional custom labels for filtering/organizing. */
  labels?: string[];
  /** Tier zones the design accepts. */
  eligibleTiers?: number[];
  eligibleBonus?: number[];
  /**
   * Six rows of six marks, each resolving to a cell class: "." the design's
   * default, else a legend key. Tiles paint zones: the reserved `solid` class
   * is laid only by micro builders, and "#" is refused.
   */
  cells?: string[];
  legend?: Record<string, string>;
  walls?: InteriorWall[];
  /**
   * Per-side perimeter segment contracts, six per side, ordered west to east on
   * N/S and north to south on E/W. Tile selection reads each entry as the class
   * the neighbouring cell must take ("any" defers); barrier words share the
   * same slot until issue #33 separates them. Omitted sides are entirely "any".
   */
  edges?: Partial<Record<Side, string[]>>;
  /** Per-side perimeter vertex contracts, seven per side, same ordering. */
  corners?: Partial<Record<Side, string[]>>;
  /** Explicit metadata for any individual primitive; wins over the shorthands. */
  primitives?: PrimitiveOverrides;
}
export interface TileSet {
  id: string;
  members: string[];
}
export interface SetPieceSlot {
  dx: number;
  dy: number;
  tileSetId: string;
    orientation?: number;
}
export interface SetPiece {
  id: string;
  category?: "enormous" | "medium" | "small" | "start" | "end";
  class: string;
  eligibleTiers: number[];
  tiles: SetPieceSlot[];
}
export interface Library {
  version: number;
  /**
   * Every cell class a design may paint, declared. The reserved `any`, `solid`
   * (micro builders only) and empty outside classes are not listed here.
   */
  cellClasses?: Record<string, CellClass>;
  tiles: TileDesign[];
  tileSets: TileSet[];
  setPieces: SetPiece[];
}

export interface MapParams {
  /** Game enforces the calibrated set-piece recipe; playground omits that recipe. */
  mode?: "game" | "playground";
  /** Tiles per zone, west to east. The map is covered by whole zones. */
  zoneWidth: number;
  /** Tiles per zone, north to south. Conventionally half `zoneWidth`. */
  zoneHeight: number;
  /** Derived: `ZONE_COLUMNS * zoneWidth`. Kept because everything downstream reads it. */
  columns: number;
  /** Derived: `ZONE_ROWS * zoneHeight`. */
  rows: number;
  tileSize: number;
  /** Loot density in tier 1, and the step added per tier above it. */
  lootChance: number;
  lootTierStep: number;
  exitCount: number;
  contestantRadius: number;
  hunterRadius: number;
}

/**
 * A tier zone: a macro area with its own extent, carrying the progression
 * parameters for everything inside it. Zones tile the map exactly, so the map
 * boundary is the stair-stepped union of occupied zones rather than a smooth
 * diamond. Derived from `zoneWidth`/`zoneHeight`, so nothing here is stored in
 * the artifact.
 */
export interface MapZone {
  id: string;
  /** Position in the zone grid, not in tiles. */
  col: number;
  row: number;
  /** Horizontal progression, `col + 1`, running 1..5. */
  tier: number;
  /** Distance in zone rows from the middle row, running 0..2. */
  bonus: number;
  /**
   * Chance that a spaced slot inside this zone carries loot. Rises with tier,
   * which is what makes loot a property of where you are on the map. Passed
   * into whichever builder runs here.
   */
  lootChance: number;
  /** Inclusive bounds in TILE units: [x0, y0, x1, y1]. */
  tiles: Box;
  /** Inclusive bounds in CELL units. */
  cells: Box;
}
/**
 * One occupied slot of the tile mask. `x`/`y` are in TILE units here and are
 * overwritten in CELL units once the slot becomes a `PlacedTile`; see the
 * coordinate table in docs/VOCABULARY.md.
 */
export interface MaskCell {
  x: number;
  y: number;
  col: number;
  row: number;
  id: string;
  /** The zone that covers this slot. Progression lives on the zone, not here. */
  zoneId: string;
}
/** `x`/`y` and `anchor` are in CELL units; `col`/`row` stay in TILE units. */
export interface PlacedTile extends MaskCell {
  templateId: string;
  orientation: number;
  setPieceId?: string;
  /** Where a body may stand to serve every seam this tile must serve. */
  anchor: Point;
}
/**
 * A seam two neighbouring tiles leave walkable between them. Measured from the
 * laid-out geometry after placement, never authored or planned: `width` is the
 * widest continuous opening along the seam and `kind` is only a coarse name for
 * that width. A neighbouring pair with no opening has no edge at all.
 */
export interface MapEdge {
  a: string;
  b: string;
  width: number;
  kind: PortKind;
}
export type FeatureKind =
  "spawn" | "hunter-spawn" | "exit" | "warp" | "charger" | "set-piece";
export interface MapFeature {
  id: string;
  kind: FeatureKind;
  tileId: string;
  x: number;
  y: number;
  setPieceId?: string;
  tileIds?: string[];
}
export interface CellSpawn {
  kind: string;
}
/** A read-through view of one cell; the artifact stores coded grids, not these. */
export interface MapCell {
  x: number;
  y: number;
  cellClass: string;
  /** True when the class is the reserved material class. */
  blocked: boolean;
  spawn: CellSpawn | null;
  height: number;
}
/**
 * Every primitive the map contains, in map cell coordinates. Cells are indexed
 * y * width + x; vertices y * (width + 1) + x; segments run vertical-first,
 * offset * (width + 1) + line, then horizontal at line * width + offset.
 */
export interface PrimitiveGrid {
  width: number;
  height: number;
  cells: {
    class: CodedGrid<string>;
    originalClass?: CodedGrid<string>;
    constraints?: CodedGrid<string>;
    /** Absent while the map is flat. */
    level?: CodedGrid<number>;
    /** Sparse by nature, so stored as a list rather than a grid. */
    spawns: Array<{ cell: number; kind: string }>;
  };
  segments: { open: CodedGrid<Span> };
  /**
   * Explicit vertex metadata only. Interior vertices carry nothing a flat map
   * cannot derive, and a perimeter vertex nobody constrained simply defers, so
   * neither is stored.
   */
  vertices: Array<{ vertex: number; class?: string; height?: number }>;
}
export interface RegionManifest {
  generator?: string;
  spawnsPlaced: number;
  obstaclesPlaced: number;
  corridorsHonored: boolean;
}
export interface MapRegion {
  id: string;
  cellClass: string;
  area: number;
  cells: number[];
  seed: number;
  /**
   * Collidable geometry this region's micro pass placed. It is not grid
   * aligned: micro detail is free of the cell lattice, and only has to stay
   * inside the region that produced it.
   */
  obstacles: Wall[];
  manifest: RegionManifest;
}
export interface Vertex {
  x: number;
  y: number;
  height: number;
}
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
export interface MapMetrics {
  tileCount: number;
  /** Tile-graph leaves over measured seams. Not a geometric cul-de-sac. */
  deadEnds: number;
  /** Seams a contestant can pass and a hunter cannot, counted from geometry. */
  squeezes: number;
  /** Neighbouring tile pairs the designs left with no opening between them. */
  sealedSeams?: number;
  /**
   * Route metrics are measured on the coarse tile graph. Each is `Infinity`
   * when that graph has no route to measure, even on a valid map.
   */
  contestantDistance: number;
  hunterDistance: number;
  detourRatio: number;
  /** Exits the contestant tile graph cannot reach from the spawn. */
  unroutedExits?: number;
  regionCount: number;
  /** Legacy path only: V2 places no adapter fallbacks yet (#35). */
  templateFallbacks?: number;
  lootCount: number;
  interiorWalls: number;
  solidFraction: number;
  largestRegion: number;
  exitCostSpread?: number;
  hunterToContestantRatio?: number;
  adapterFraction?: number;
  [key: string]: number | undefined;
}
export interface GeneratedMap {
  version: number;
  seed: string;
  params: MapParams;
  width: number;
  height: number;
  /** Derived from the params, in zone-grid order. Not stored in the artifact. */
  zones: MapZone[];
  tiles: PlacedTile[];
  edges: MapEdge[];
  walls: Wall[];
  features: MapFeature[];
  grid: PrimitiveGrid;
  regions: MapRegion[];
  metrics: MapMetrics;
  validation: ValidationResult;
}

/**
 * The minimum a clearance or navigation query needs. Template fitting builds a
 * single-tile instance of this, so the same lattice code serves both scales.
 */
export interface NavTarget {
  width: number;
  height: number;
  walls: Wall[];
  params?: Pick<MapParams, "tileSize">;
  tiles?: Array<{ x: number; y: number }>;
  navBoxes?: Box[];
}

export interface RegionCandidate {
  cellIndex: number;
  x: number;
  y: number;
  /**
   * The loot density in force at this cell, from the tier zone covering it. A
   * region may span zones, so it is carried per candidate rather than per
   * region.
   */
  lootChance?: number;
}
export interface RegionInput {
  seed: string | number;
  cellClass: string;
  /** Spaced slots offered for spawns. */
  candidates: RegionCandidate[];
  /** Hard cap on the spawns this region may place. */
  budget: number;
  /** Every open cell of the region, for detail that wants a denser basis. */
  area?: RegionCandidate[];
}
export interface RegionSpawn {
  cellIndex: number;
  kind: string;
}
/**
 * What a region builder may return. Extending this so a builder can also state
 * cells, segments and vertices inside its own area is NEXT_TASKS item 10.
 */
export interface RegionOutput {
  spawns: RegionSpawn[];
  obstacles: Wall[];
  manifest: RegionManifest;
}
