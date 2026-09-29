/**
 * The micro generation contract.
 *
 * A region builder is handed an area and the macro parameters in force over it,
 * and returns declarations over the lattice -- never physical objects, per
 * docs/archive/pre-integration/VOCABULARY.md. It may state cells, segments and vertices inside its own
 * area, place off-lattice collidable props, and claim spawn slots.
 *
 * A region is an area, not an enclosure, and is not tile shaped: it may span any
 * number of tiles at any offset. A builder is therefore written against the
 * region's own shape, and consults the tile lattice only where it wants to --
 * `RegionContext.grid` exposes the 6 x 6 axis so a builder may align to it,
 * which is encouraged for the bulk of structures and required of nothing.
 */
import type {
  Box,
  CellClass,
  MapParams,
  RegionCandidate,
  RegionManifest,
  RegionSpawn,
  Span,
  Wall,
} from "../types.ts";

/**
 * One segment, in the addressing the whole project already uses:
 * `segmentIndex(vertical, line, offset)`. For a vertical segment `line` is the
 * x of the grid line and `offset` the row; for a horizontal one `line` is the y
 * and `offset` the column.
 */
export interface SegmentRef {
  vertical: boolean;
  line: number;
  offset: number;
}

/** A cell address in map cell coordinates, with its index into the cell grid. */
export interface CellRef {
  cellIndex: number;
  x: number;
  y: number;
}

/**
 * A boundary segment through which the region currently connects to the rest of
 * the map. A builder may narrow one, but sealing every opening strands the
 * region, so the harness checks these after the fact rather than trusting a
 * builder to have been careful.
 */
export interface RegionOpening extends SegmentRef {
  /** The region cell on this side of the segment. */
  inside: CellRef;
  /** The cell on the far side, which belongs to some other region. */
  outside: CellRef;
  /** Widest continuous opening the segment currently carries. */
  width: number;
  /** True when no route may be allowed to lose this opening. */
  required: boolean;
}

/**
 * The tile lattice, offered to a builder that wants to align to it. A region
 * does not have to respect the grid, but border geometry usually should, and a
 * structure that wants to read as built rather than scattered usually does.
 */
export interface GridAxis {
  /** Cells per tile edge; 6 for every map this project generates. */
  tileSize: number;
  /** Tile column and row covering a cell. */
  tileOf(x: number, y: number): { col: number; row: number };
  /** Inclusive cell bounds of a tile, in cells. */
  tileBounds(col: number, row: number): Box;
  /** True when the cell sits against a tile boundary in either axis. */
  onTileBorder(x: number, y: number): boolean;
  /** True when the segment lies on a tile seam. */
  onTileSeam(ref: SegmentRef): boolean;
  /** Snap a cell coordinate to the nearest tile-aligned lattice line. */
  snap(value: number): number;
}

/** Named, order-independent random streams. Two draws never interfere. */
export interface Rng {
  /** A new stream, deterministic in the region seed and this name. */
  stream(name: string): Rng;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** One member, or undefined for an empty list. Never mutates the input. */
  pick<T>(items: readonly T[]): T | undefined;
  /** A copy in a deterministic shuffled order. */
  shuffle<T>(items: readonly T[]): T[];
}

/**
 * The region's cell set, and the shape questions a builder actually asks of it.
 * Queries are in map cell coordinates throughout; nothing here is region-local,
 * because a region has no natural origin.
 */
export interface RegionMask {
  /** Map cell grid dimensions, so an index converts either way. */
  width: number;
  height: number;
  /** Every cell of the region, ascending by index. */
  cells: readonly CellRef[];
  /** Inclusive cell bounds of the region: [x0, y0, x1, y1]. */
  bounds: Box;
  area: number;
  has(x: number, y: number): boolean;
  indexOf(x: number, y: number): number;
  /** Cells at least `depth` cells from anything outside the region. */
  interior(depth: number): CellRef[];
  /** Cells with at least one neighbour outside the region. */
  border(): CellRef[];
  /** Chebyshev distance from the cell to the nearest cell outside the region. */
  depthAt(x: number, y: number): number;
  /** Every maximal axis-aligned rectangle of region cells at least this big. */
  rects(minWidth: number, minHeight: number): Box[];
  /** The largest such rectangle by area, or null when none fits. */
  largestRect(minWidth?: number, minHeight?: number): Box | null;
  /**
   * Cells on a lattice of the given step, offset by `phase`. Used to space
   * detail without positional bias; the default candidate set is this at step 2,
   * phase 1.
   */
  lattice(step: number, phaseX?: number, phaseY?: number): CellRef[];
  /** Region cells inside a sub-box, for a builder that partitioned its area. */
  within(box: Box): CellRef[];
}

/** A route through the region that micro geometry must not sever. */
export interface ReservedCorridor {
  /** Centre line, in map cell coordinates. */
  points: Array<{ x: number; y: number }>;
  /** Half width that must stay clear either side of the centre line. */
  radius: number;
}

/** What a builder is given. Everything it needs is passed in, never looked up. */
export interface RegionContext {
  /** Stable id of the region, for manifests and diagnostics. */
  regionId: string;
  cellClass: string;
  /** What is intrinsic to the class, from the library's `cellClasses`. */
  rule: CellClass;
  seed: number | string;
  rng: Rng;
  mask: RegionMask;
  grid: GridAxis;
  params: MapParams;
  /** Spaced slots offered for spawns, each carrying its zone's loot density. */
  candidates: RegionCandidate[];
  /** Hard cap on spawns this region may place. */
  budget: number;
  /**
   * Cells the builder must leave alone because another pass owns them. Macro
   * features and the tiles carrying them are reserved this way.
   */
  isReserved(x: number, y: number): boolean;
  /**
   * The subset of reserved ground that is there because a body must be able to
   * STAND on it -- a tile anchor, the room behind an opening -- as opposed to
   * ground it merely walks along, which is what a street is.
   *
   * The two want opposite treatment and conflating them costs a builder either
   * its output or the map. A wall or a pillar beside a street is wanted: it is
   * what stops the street being a clear shot. The same wall beside an anchor
   * puts geometry half a cell from a point validation requires to be standing
   * room, and the map is invalid.
   */
  isStandingRoom(x: number, y: number): boolean;
  /** Boundary segments the region is currently reachable through. */
  openings: RegionOpening[];
  /**
   * The perimeter contract macro planned for this region, when it was planned
   * rather than discovered. A builder must honour every port; `micro/conform.ts`
   * checks that it did.
   *
   * Absent on the legacy path, where regions are discovered from cell classes
   * after the fact and there is no macro plan to honour.
   */
  ports?: PerimeterPort[];
  /** What macro decided this region owes in loot, when there is a plan. */
  loot?: LootCriteria;
  /**
   * Routes crossing this region that must survive. A builder may build up to
   * one but not across it. archived NEXT_TASKS item 4: until a proven route envelope
   * reaches here this is empty and the post-edit clearance check is the guard.
   */
  corridors: ReservedCorridor[];
  /** Body radii in force, from the macro params. */
  clearance: { contestant: number; hunter: number };
  /** Tier zone covering a cell, for a builder whose form varies with progression. */
  zoneAt(
    x: number,
    y: number,
  ): { tier: number; bonus: number; lootChance: number };
}

/**
 * What must be able to get through an opening, named by the largest body that
 * must fit. Ordered: "none" < "contestant" < "hunter".
 *
 * A body band, not a width, because the widths are derived (see `scale.ts`) and
 * because the whole point of the contract is that macro can reason about
 * passage without knowing what micro will actually build there.
 */
export type Passage = "none" | "contestant" | "hunter";

/**
 * One run of contiguous perimeter segments a region shares with one neighbour,
 * and the passage band micro must leave across it.
 *
 * This is the macro-to-micro contract, and it is two sided on purpose:
 *
 * - `required` is a floor. When micro is done, something of at least this size
 *   must be able to cross this port. Macro proves reachability from the floors
 *   alone, so the proof holds whatever micro decides to build inside a region.
 * - `allowed` is a ceiling. `"contestant"` keeps a port a squeeze no hunter may
 *   use however open micro would like it; `"none"` seals it.
 *
 * `required` of `"none"` with `allowed` of `"hunter"` is a port micro may do
 * whatever it likes with, which is the ordinary case away from the routes macro
 * actually depends on.
 */
export interface PerimeterPort {
  id: string;
  /** The region across this port, or null where it faces outside the map. */
  neighbour: string | null;
  /** The segments the port covers, ordered along the boundary. */
  segments: SegmentRef[];
  /** The floor: micro must leave at least this much open somewhere on it. */
  required: Passage;
  /** The ceiling: micro may not leave more than this open anywhere on it. */
  allowed: Passage;
}

/**
 * What a region owes in loot, decided by macro and handed down.
 *
 * Macro decides how much and of what tier, because that is progression and it
 * is a property of where the region sits on the map. Where the spawns actually
 * go is the region's own business -- it is the only thing that knows what it
 * built -- under one rule: a cell carries at most one loot spawn.
 */
export interface LootCriteria {
  /** How many spawns this region should place. A target, and a hard cap. */
  budget: number;
  /** Loot tier in force here, 1..5, from the zone covering the region. */
  tier: number;
  /** Per-cell chance, for a builder that would rather scatter than count. */
  density: number;
}

/** A cell declaration a builder makes inside its own area. */
export interface CellEdit {
  cellIndex: number;
  class?: string;
  height?: number;
}
/** A segment declaration. `open` is null for a full barrier, [0, 1] for clear. */
export interface SegmentEdit {
  ref: SegmentRef;
  open: Span;
}
export interface VertexEdit {
  x: number;
  y: number;
  class?: string;
  height?: number;
}
/** A macro feature a builder sited itself; physical exits are a micro detail. */
export interface FeatureEdit {
  kind: string;
  x: number;
  y: number;
}

/**
 * What a builder returns. This supersedes `RegionOutput`, which could state only
 * spawns and props and so could not express a wall, a door or a window.
 */
export interface RegionEdit {
  spawns: RegionSpawn[];
  /** Off-lattice collidable detail. Each stays inside the region. */
  obstacles: Wall[];
  cells: CellEdit[];
  segments: SegmentEdit[];
  vertices: VertexEdit[];
  features: FeatureEdit[];
  manifest: MicroManifest;
}

export interface MicroManifest extends RegionManifest {
  generator: string;
  /** Declarations the containment or clearance contract refused. */
  rejected?: number;
  /** Free-form counts a builder wants visible in the artifact. */
  notes?: Record<string, number>;
}

/**
 * One entry of the catalogue. A builder is selected by name from the class rule,
 * so which generator runs over a region is library data rather than code.
 */
export interface RegionBuilder {
  id: string;
  /** One line, shown by tooling that lists the catalogue. */
  description: string;
  /**
   * Smallest area, in cells, the builder can do anything with. Below it the
   * catalogue falls back rather than letting a builder fail.
   */
  minArea: number;
  build(context: RegionContext): RegionEdit;
}
