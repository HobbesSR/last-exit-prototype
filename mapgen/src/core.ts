import DEFAULT_LIBRARY_JSON from "../content/default-library.json" with { type: "json" };
import { composeMacro } from "./macro.ts";
import { getDifficulty, solveWfc, getRotatedEdge } from "./wfc.ts";
import type { WfcGrid, TileOption } from "./wfc.ts";
import type { MacroPlacement } from "./macro-types.ts";
import { compileTileDesign } from "./macro-compiler.ts";
import { validateCellClass } from "./regions.ts";
import { builderFor, createMask, createRng } from "./micro/index.ts";
import type {
  GridAxis,
  RegionContext,
  RegionMask,
  RegionOpening,
  ReservedCorridor,
} from "./micro/types.ts";
import {
  LATTICE_STEP,
  clearNavCache,
  latticeFor,
  nodeIndex,
  pointClear,
  reachable,
} from "./nav.ts";
import { segmentSegmentDistance } from "./geometry.ts";
import { validateTileShape } from "./tiles.ts";

/** One tile beside another, and the side of each that faces the other. */
interface Neighbour {
  j: number;
  side: Side;
  opposite: Side;
}
import {
  ANY_CLASS,
  SIDES,
  SOLID_CLASS,
  widestOpening,
  mergeRuns,
} from "./primitives.ts";
import type { VertexMeta } from "./primitives.ts";
import { decodeGrid, encodeGrid, gridReader, validateGrid } from "./coding.ts";
import type { CodedGrid } from "./coding.ts";
import type {
  Box,
  GeneratedMap,
  SetPieceSlot,
  Library,
  MapCell,
  MapEdge,
  MapFeature,
  MapInteriors,
  MapLayout,
  MapParams,
  MapRegion,
  MapStructure,
  MapZone,
  PrimitiveGrid,
  MaskCell,
  NavTarget,
  PlacedTile,
  Point,
  PortKind,
  PortValue,
  Side,
  Span,
  TileDesign,
  TileSet,
  ValidationResult,
  Wall,
  Agent,
} from "./types.ts";

export type * from "./types.ts";

interface NavCache {
  byId: Map<string, number>;
  contestant?: Map<string, string[]>;
  hunter?: Map<string, string[]>;
}
export const OUTSIDE_CLASS = "";
export const SPAN_EPS = 1e-9;

/** The primitive grids under construction, addressed in map cell coordinates. */
export interface GridBuild {
  W: number;
  H: number;
  cellClass: string[];
  cellLevel: number[];
  segmentOpen: Span[];
  /** Explicit vertex metadata only; an absent vertex is deferred and flat. */
  vertices: Map<number, VertexMeta>;
  segmentIndex: (vertical: boolean, line: number, offset: number) => number;
}

/**
 * The zone grid. Five columns give the five horizontal tiers; five rows give
 * the bonus axis, rising away from the middle. A zone is occupied when it lies
 * within two steps of the centre by Manhattan distance, which is the diamond
 * the design notes draw:
 *
 *     X X 5 X X
 *     X 3 4 3 X
 *     1 2 3 4 5
 *     X 3 4 3 X
 *     X X 5 X X
 */
export const ZONE_COLUMNS = 5;
export const ZONE_ROWS = 5;
const ZONE_CENTRE_COL = (ZONE_COLUMNS - 1) / 2;
const ZONE_CENTRE_ROW = (ZONE_ROWS - 1) / 2;
const ZONE_REACH = 2;

export function zoneOccupied(col: number, row: number): boolean {
  return (
    Math.abs(col - ZONE_CENTRE_COL) + Math.abs(row - ZONE_CENTRE_ROW) <=
    ZONE_REACH
  );
}

export const DEFAULT_PARAMS = Object.freeze({
  // 12 x 6 tiles per zone, across a 5 x 5 zone grid: a 60 x 30 tile bounding box.
  zoneWidth: 12,
  zoneHeight: 6,
  columns: ZONE_COLUMNS * 12,
  rows: ZONE_ROWS * 6,
  tileSize: 6,
  // Loot density at tier 1, rising by this step per tier: 0.04 at tier 1 to
  // 0.40 at tier 5, so the gradient is the whole of the progression.
  lootChance: 0.04,
  lootTierStep: 0.09,
  exitCount: 2,
  contestantRadius: 0.55,
  hunterRadius: 0.9,
});
export const DEFAULT_LIBRARY = DEFAULT_LIBRARY_JSON as unknown as Library;
export const DIRS: Array<[number, number, Side, Side]> = [
  [0, -1, "N", "S"],
  [1, 0, "E", "W"],
  [0, 1, "S", "N"],
  [-1, 0, "W", "E"],
];
export const APERTURES: Record<string, number> = {
  squeeze: 1.5,
  door: 2,
  wide: 3,
};
const PORT_KINDS: PortKind[] = ["closed", "door", "wide", "squeeze"];
const tileCaches = new WeakMap<GeneratedMap, Set<string>>();
const navCaches = new WeakMap<GeneratedMap, NavCache>();
const reachCaches = new WeakMap<
  GeneratedMap,
  Map<number, Array<Set<number> | undefined>>
>();
const portSets = new Map<string, Set<PortKind> | null>();
const viewCaches = new WeakMap<GeneratedMap, GridViews>();

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
export function key(x: number, y: number): string {
  return `${x},${y}`;
}

/** An omitted side defers, so a design need not mention ports at all. */
/** A port declares the set of seam contracts it accepts: "any", "door|wide", …. */
function portSet(value: PortValue | undefined): Set<PortKind> | null {
  const text = Array.isArray(value) ? value.join("|") : value;
  if (typeof text !== "string") return null;
  const cached = portSets.get(text);
  if (cached !== undefined) return cached;
  const parts = text.split("|").map((part) => part.trim());
  const isKind = (part: string): part is PortKind =>
    (PORT_KINDS as string[]).includes(part);
  const set = parts.includes("any")
    ? new Set(PORT_KINDS)
    : new Set(parts.filter(isKind));
  const value_ = parts.every((part) => part === "any" || isKind(part))
    ? set
    : null;
  portSets.set(text, value_);
  return value_;
}
/**
 * Every cell class this library declares, plus the reserved material class.
 * A design may only paint a name from this list.
 */
export function cellClassNames(library: Library | null | undefined): string[] {
  return [
    ...new Set([
      ...Object.keys(library?.cellClasses ?? {}),
      ANY_CLASS,
    ]),
  ];
}
/** The names a design actually uses, whether or not they are declared. */
function usedCellClasses(library: Library | null | undefined): string[] {
  const names = new Set<string>();
  for (const tile of library?.tiles || []) {
    if (typeof tile?.defaultCellClass === "string")
      names.add(tile.defaultCellClass);
    for (const painted of Object.values(tile?.legend || {}))
      if (typeof painted === "string") names.add(painted);
  }
  return [...names];
}

export function validateLibrary(input: unknown): ValidationResult {
  const library = input as Library;
  const errors: string[] = [];
  if (
    !library ||
    (library.version !== 1 && library.version !== 2) ||
    !Array.isArray(library.tiles) ||
    !library.tiles.length ||
    !Array.isArray(library.tileSets) ||
    !Array.isArray(library.setPieces)
  )
    return {
      valid: false,
      errors: [
        "library requires version 1 or 2, nonempty tiles, tileSets and setPieces arrays",
      ],
    };
  const named = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (library.cellClasses !== undefined) {
    if (
      !library.cellClasses ||
      typeof library.cellClasses !== "object" ||
      Array.isArray(library.cellClasses)
    )
      errors.push("cellClasses must be an object");
    else
      for (const [name, rule] of Object.entries(library.cellClasses)) {
        if (name === ANY_CLASS || !name.trim())
          errors.push(`cell class ${name} is reserved`);
        const result = validateCellClass(rule);
        for (const message of result.errors)
          errors.push(`cell class ${name}: ${message}`);
      }
  }
  // A design may only paint a declared class, so the registry is the single
  // place a class is introduced and the editor can offer a closed list.
  {
    const declared = new Set(cellClassNames(library));
    for (const name of usedCellClasses(library))
      if (!declared.has(name))
        errors.push(
          `cell class ${name} is used but not declared in cellClasses`,
        );
  }
  const ids = new Set<string>();
  for (const t of library?.tiles || []) {
    if (!t || typeof t !== "object") {
      errors.push("malformed tile");
      continue;
    }
    if (!named(t.id) || ids.has(t.id))
      errors.push(`duplicate or missing tile id: ${t.id}`);
    ids.add(t.id);
    if (!named(t.defaultCellClass))
      errors.push(`tile ${t.id} needs a defaultCellClass`);
    const zoneList = (
      field: string,
      list: number[] | undefined,
      lo: number,
      hi: number,
    ) => {
      if (list === undefined) return;
      if (
        !Array.isArray(list) ||
        !list.length ||
        list.some((v) => !Number.isInteger(v) || v < lo || v > hi)
      )
        errors.push(`tile ${t.id} ${field} must list integers ${lo}..${hi}`);
    };
    zoneList("eligibleTiers", t.eligibleTiers, 1, 5);
    zoneList("eligibleBonus", t.eligibleBonus, 0, 4);
    if (
      !Array.isArray(t.orientations) ||
      !t.orientations.length ||
      t.orientations.some((x) => ![0, 90, 180, 270].includes(x))
    )
      errors.push(`tile ${t.id} has invalid orientations`);
    if (t.ports !== undefined) {
      if (!t.ports || typeof t.ports !== "object" || Array.isArray(t.ports))
        errors.push(`tile ${t.id} ports must be an object`);
      else
        for (const d of SIDES)
          if (t.ports[d] !== undefined && !portSet(t.ports[d])?.size)
            errors.push(`tile ${t.id} has invalid ${d} port`);
    }
    for (const message of validateTileShape(t))
      errors.push(`tile ${t.id}: ${message}`);
  }
  const sets = new Map<string, TileSet>();
  for (const set of library?.tileSets || []) {
    if (!set || typeof set !== "object") {
      errors.push("malformed tileSet");
      continue;
    }
    if (!named(set.id) || sets.has(set.id))
      errors.push(`duplicate or missing tileSet id: ${set.id}`);
    sets.set(set.id, set);
    if (!Array.isArray(set.members) || !set.members.length) {
      errors.push(`tileSet ${set.id} needs nonempty members`);
      continue;
    }
    for (const member of set.members || [])
      if (!ids.has(member))
        errors.push(`tileSet ${set.id} references unknown tile ${member}`);
  }
  const setPieceIds = new Set<string>();
  for (const setPiece of library?.setPieces || []) {
    if (!setPiece || typeof setPiece !== "object") {
      errors.push("malformed set piece");
      continue;
    }
    if (
      !named(setPiece.id) ||
      setPieceIds.has(setPiece.id) ||
      !named(setPiece.class) ||
      !Array.isArray(setPiece.eligibleTiers) ||
      !Array.isArray(setPiece.tiles) ||
      !setPiece.tiles.length
    ) {
      errors.push(
        `set piece ${setPiece?.id || "?"} is incomplete or duplicated`,
      );
      continue;
    }
    setPieceIds.add(setPiece.id);
    if (
      !setPiece.eligibleTiers.length ||
      setPiece.eligibleTiers.some((t) => !Number.isInteger(t) || t < 1 || t > 5)
    )
      errors.push(`set piece ${setPiece.id} needs tiers 1..5`);
    const coords = new Set<string>();
    for (const spot of setPiece.tiles || []) {
      if (!spot || !Number.isInteger(spot.dx) || !Number.isInteger(spot.dy)) {
        errors.push(`set piece ${setPiece.id} has invalid coordinate`);
        continue;
      }
      const c = key(spot.dx, spot.dy);
      if (coords.has(c))
        errors.push(`set piece ${setPiece.id} overlaps at ${c}`);
      coords.add(c);
      if (!sets.has(spot.tileSetId))
        errors.push(
          `set piece ${setPiece.id} references unknown tileSet ${spot.tileSetId}`,
        );
    }
  }
  return { valid: !errors.length, errors };
}

/** Every occupied zone, with its extent in both tiles and cells. */
export function makeZones(p: MapParams): MapZone[] {
  const zones: MapZone[] = [];
  for (let row = 0; row < ZONE_ROWS; row++)
    for (let col = 0; col < ZONE_COLUMNS; col++) {
      if (!zoneOccupied(col, row)) continue;
      const x0 = col * p.zoneWidth,
        y0 = row * p.zoneHeight;
      const x1 = x0 + p.zoneWidth - 1,
        y1 = y0 + p.zoneHeight - 1;
      const tier = col + 1;
      zones.push({
        id: `z-${col}-${row}`,
        col,
        row,
        tier,
        bonus: Math.abs(row - ZONE_CENTRE_ROW),
        // Loot rises with horizontal progress. The bonus axis is deliberately
        // not folded in until the diagram's combination rule is settled.
        lootChance: Math.min(
          1,
          Math.max(0, p.lootChance + (tier - 1) * p.lootTierStep),
        ),
        tiles: [x0, y0, x1, y1],
        cells: [
          x0 * p.tileSize,
          y0 * p.tileSize,
          (x1 + 1) * p.tileSize - 1,
          (y1 + 1) * p.tileSize - 1,
        ],
      });
    }
  return zones;
}

/**
 * The widest opening the seam between two neighbouring tiles actually carries.
 * Both coordinates are in cells. This is a measurement of laid-out geometry,
 * not a plan: the generator states nothing about a seam, so what is there is
 * whatever the two tiles beside it declared.
 */
export function seamOpening(
  read: (vertical: boolean, line: number, offset: number) => Span,
  a: { x: number; y: number },
  b: { x: number; y: number },
  tileSize: number,
): number {
  const vertical = a.y === b.y;
  const line = vertical ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  const base = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
  return widestOpening(
    Array.from({ length: tileSize }, (_, i) => read(vertical, line, base + i)),
  ).width;
}
/**
 * The coarse name for an opening of this width. A label over a measurement:
 * passability is decided by the width and the geometry, never by the name.
 */
export function seamKind(width: number): PortKind {
  if (width >= APERTURES.wide!) return "wide";
  if (width >= APERTURES.door!) return "door";
  return "squeeze";
}

/**
 * Region search: the final macro pass. Contiguous cells join when they share a
 * region class and the segment between them is clear. Regions are therefore
 * nonrectangular by construction and one tile may contribute cells to several
 * regions. Tiles are not consulted; only laid-out primitives are.
 */
export function searchRegions(
  grid: Pick<
    GridBuild,
    "W" | "H" | "cellClass" | "segmentOpen" | "segmentIndex"
  >,
  seed: string,
): MapRegion[] {
  const { W, H, cellClass, segmentOpen, segmentIndex } = grid;
  const clear = (index: number) => {
    const span = segmentOpen[index];
    return !!span && span[0] <= SPAN_EPS && span[1] >= 1 - SPAN_EPS;
  };
  const regionOf = new Int32Array(W * H).fill(-1);
  const regions: MapRegion[] = [];
  for (let seedCell = 0; seedCell < W * H; seedCell++) {
    if (regionOf[seedCell]! >= 0) continue;
    const rc = cellClass[seedCell]!;
    // Only cells no tile covers lie outside every region.
    if (rc === OUTSIDE_CLASS) continue;
    const queue: number[] = [seedCell],
      members: number[] = [];
    regionOf[seedCell] = regions.length;
    while (queue.length) {
      const at = queue.pop()!;
      members.push(at);
      const x = at % W,
        y = (at - x) / W;
      const step = (nx: number, ny: number, segment: number) => {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
        const next = ny * W + nx;
        if (regionOf[next]! >= 0) return;
        if (cellClass[next] !== rc || !clear(segment)) return;
        regionOf[next] = regions.length;
        queue.push(next);
      };
      step(x - 1, y, segmentIndex(true, x, y));
      step(x + 1, y, segmentIndex(true, x + 1, y));
      step(x, y - 1, segmentIndex(false, y, x));
      step(x, y + 1, segmentIndex(false, y + 1, x));
    }
    members.sort((a, b) => a - b);
    regions.push({
      id: `r-${regions.length}`,
      cellClass: rc,
      area: members.length,
      cells: members,
      seed: hash(`${seed}:${rc}:${seedCell % W},${Math.floor(seedCell / W)}`),
      obstacles: [],
      manifest: { corridorsHonored: true, spawnsPlaced: 0, obstaclesPlaced: 0 },
    });
  }
  return regions;
}

/**
 * SUPERSEDED, and kept because `generateMap` still depends on it.
 *
 * `src/plan/` replaces this whole idea. Everything below exists because macro
 * had no way to state what it needed, so connectivity had to be defended after
 * the fact: ground reserved from every builder, props dropped.
 * The planned path has macro state a floor and a ceiling on every region
 * boundary instead, proves reachability from the floors, and holds each builder
 * to them -- which needs no reserved ground and no repair. See
 * docs/PLANNED_GENERATION.md.
 *
 * Do not extend this. `generateMap` is the only caller and should stay that way.
 *
 * The street network: the macro skeleton micro generation may not build on.
 *
 * A builder sees one region and nothing else, so a per-region clearance guard
 * cannot protect a route that crosses several regions -- and on this map every
 * route does. Worse, a region may be most of the open field, in which case its
 * builder is deciding whole-map connectivity while looking at an area whose
 * boundary tells it nothing. No amount of care inside a builder fixes that: the
 * information is not there to be careful with.
 *
 * So the network is decided before any builder runs, out of the composed
 * geometry, and handed down. The cells it covers are reserved, so nothing may
 * be placed in them, and its legs reach each builder as `RegionContext.corridors`
 * so the clearance guard can check what it was asked to protect. What is left
 * over is what may be built on -- which is how a map ends up with streets and
 * blocks rather than with a maze, and is the reserved-corridor input
 * NEXT_TASKS item 4 asks for.
 *
 * Two properties are load-bearing:
 *
 * A leg is a **proven** route, not a straight line. It is a path on the same
 * swept-disc lattice route validation uses, confined to the two tiles it joins,
 * so it bends around whatever the tile designs already put in the way. A
 * straight anchor-to-seam line looks right and is wrong exactly where the map
 * is most interesting: on a tile whose authored interior makes the direct line
 * impossible, the real route detours, and reserving the line leaves the detour
 * buildable -- which is where the first version of this sealed seven tiles.
 *
 * It is a spanning tree plus loops, not the full tile graph. A tree keeps every
 * tile reachable at the cost of one route through it; the loop edges stop the
 * result reading as a dendrite; and every seam left out is one a builder may
 * wall, narrow to a squeeze, or run a compound across.
 */
export interface StreetPlan {
  corridors: ReservedCorridor[];
  /** One byte per cell: 1 where the network runs and nothing may be built. */
  reserved: Uint8Array;
  /** The subset of that which is standing room rather than ground to walk. */
  standing: Uint8Array;
  legs: number;
}

/**
 * Reservation is deliberately thin: a cell is reserved when the route actually
 * passes through it, not when it lies within a body's clearance of one.
 *
 * The wide version was tried first and is the wrong trade. A lane two or three
 * cells wide through every one of 936 tiles consumes most of a 6 x 6 tile, and
 * what it leaves is gravel: blocks averaged thirty cells, below the minimum
 * area of every builder that makes buildings, so `compound` and `pillar-hall`
 * silently produced nothing at all and the map was scatter and rubble again.
 *
 * Thin reservation keeps the blocks whole, and the clearance a body needs
 * beside the route is kept by two other things instead: the per-block guard,
 * which will not let a builder sever a corridor with a wall, and `clearStreets`,
 * which drops any prop that reaches into one.
 */
const STREET_REACH = 0.5;

/** Tiles between one street and the next. The open-versus-built dial. */
const STREET_SPACING = 3;

/**
 * The lattice path between two points, confined to a box, as the points it
 * passes through. Empty when the body cannot get from one to the other inside
 * that box -- which is the question the tree is actually asking of a seam.
 */
function latticeRoute(
  target: NavTarget,
  radius: number,
  from: Point,
  to: Point,
  box: Box,
): Point[] {
  const lattice = latticeFor(target, radius);
  const start = nodeIndex(target, from.x, from.y),
    goal = nodeIndex(target, to.x, to.y);
  if (start < 0 || goal < 0 || !lattice.node[start] || !lattice.node[goal])
    return [];
  const { W, hEdge, vEdge } = lattice;
  const gx0 = Math.round(box[0] / LATTICE_STEP),
    gx1 = Math.round(box[2] / LATTICE_STEP),
    gy0 = Math.round(box[1] / LATTICE_STEP),
    gy1 = Math.round(box[3] / LATTICE_STEP);
  const parent = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (let head = 0; head < queue.length && !parent.has(goal); head++) {
    const at = queue[head]!,
      gx = at % W,
      gy = (at - gx) / W;
    const step = (next: number) => {
      if (parent.has(next)) return;
      parent.set(next, at);
      queue.push(next);
    };
    if (gx < gx1 && hEdge[at]) step(at + 1);
    if (gx > gx0 && hEdge[at - 1]) step(at - 1);
    if (gy < gy1 && vEdge[at]) step(at + W);
    if (gy > gy0 && vEdge[at - W]) step(at - W);
  }
  if (!parent.has(goal)) return [];
  const points: Point[] = [];
  for (let at = goal; at !== -1; at = parent.get(at)!) {
    const gx = at % W;
    points.push({ x: gx * LATTICE_STEP, y: ((at - gx) / W) * LATTICE_STEP });
  }
  return points.reverse();
}

export function planStreets(
  tiles: PlacedTile[],
  adj: Neighbour[][],
  grid: GridBuild,
  params: MapParams,
  root: number,
  seed: string,
): StreetPlan {
  const size = params.tileSize;
  const target: NavTarget = {
    width: grid.W,
    height: grid.H,
    walls: wallsFromLattice(
      grid.W,
      grid.H,
      (index) => grid.cellClass[index]!,
      (vertical, line, offset) =>
        grid.segmentOpen[grid.segmentIndex(vertical, line, offset)]!,
    ),
    navBoxes: [[0, 0, grid.W, grid.H]],
  };

  // Streets join blocks, not tiles, and that distinction is the whole design.
  //
  // A route to every one of 936 tiles is a route through every tile, and a
  // 6 x 6 tile has no room for both a street and a building. Blocks stay whole
  // only if the network is coarse, and it can be: the per-block clearance guard
  // already keeps a block internally connected and keeps its openings, so a
  // tile in the middle of a block is reached across the block's own ground and
  // needs no street of its own. `STREET_SPACING` is how many tiles lie between
  // one street and the next, and is the single dial between open ground and
  // buildable ground.
  const groupOf = (i: number) =>
    `${Math.floor(tiles[i]!.col / STREET_SPACING)},${Math.floor(
      tiles[i]!.row / STREET_SPACING,
    )}`;
  const members = new Map<string, number[]>();
  for (let i = 0; i < tiles.length; i++) {
    const id = groupOf(i);
    const list = members.get(id);
    if (list) list.push(i);
    else members.set(id, [i]);
  }
  // One tile speaks for each block: the one nearest its centre of mass, ties on
  // tile index, so the choice follows from the set piece and not from iteration.
  const speaker = new Map<string, number>();
  for (const [id, list] of members) {
    const cx = list.reduce((sum, i) => sum + tiles[i]!.col, 0) / list.length,
      cy = list.reduce((sum, i) => sum + tiles[i]!.row, 0) / list.length;
    speaker.set(
      id,
      list.reduce((best, i) =>
        Math.hypot(tiles[i]!.col - cx, tiles[i]!.row - cy) <
        Math.hypot(tiles[best]!.col - cx, tiles[best]!.row - cy)
          ? i
          : best,
      ),
    );
  }
  const between = new Map<string, Set<string>>();
  for (let i = 0; i < tiles.length; i++)
    for (const edge of adj[i]!) {
      const a = groupOf(i),
        b = groupOf(edge.j);
      if (a === b) continue;
      if (!between.has(a)) between.set(a, new Set());
      between.get(a)!.add(b);
    }

  const corridors: ReservedCorridor[] = [];
  const taken = new Set<string>();
  /** The ground two blocks cover, which is where a leg between them may run. */
  const spanOf = (a: string, b: string): Box => {
    const all = [...(members.get(a) ?? []), ...(members.get(b) ?? [])];
    return [
      Math.min(...all.map((i) => tiles[i]!.x)),
      Math.min(...all.map((i) => tiles[i]!.y)),
      Math.max(...all.map((i) => tiles[i]!.x)) + size,
      Math.max(...all.map((i) => tiles[i]!.y)) + size,
    ];
  };
  const addLeg = (a: string, b: string, radius: number) => {
    const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (taken.has(pairKey)) return false;
    const points = latticeRoute(
      target,
      radius,
      tiles[speaker.get(a)!]!.anchor,
      tiles[speaker.get(b)!]!.anchor,
      spanOf(a, b),
    );
    if (!points.length) return false;
    taken.add(pairKey);
    corridors.push({ points, radius });
    return true;
  };

  // A breadth-first tree from the block the contestant starts in reaches every
  // block the composed geometry actually joins. Ties break on block id, so the
  // network is a function of the geometry and of nothing else.
  //
  // Two passes, and the second is not an optimisation. The first takes only
  // routes a hunter fits along, so the spine of the network is one both bodies
  // can walk. The second then reaches whatever is left at contestant clearance,
  // because a block joined to the map only by a squeeze still has to survive
  // micro generation: with no street it is buildable ground and the one way in
  // gets filled.
  const seen = new Set<string>([groupOf(root)]);
  const queue = [groupOf(root)];
  for (const radius of [params.hunterRadius, params.contestantRadius]) {
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head]!;
      for (const next of [...(between.get(at) ?? [])].sort()) {
        if (seen.has(next)) continue;
        if (!addLeg(at, next, radius)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  // Then loops. A pure tree makes every block a cul-de-sac, which is the maze
  // this map is trying to stop being, so a deterministic minority of the
  // remaining block pairs become streets too.
  for (const [a, neighbours] of [...between].sort((x, y) =>
    x[0].localeCompare(y[0]),
  ))
    for (const b of [...neighbours].sort()) {
      if (b <= a) continue;
      if (hash(`${seed}:loop:${a}:${b}`) % 3 !== 0) continue;
      addLeg(a, b, params.hunterRadius);
    }

  // Rasterise. A cell is reserved when its centre is close enough to the route
  // that anything placed in it could reach into the clearance a body needs.
  const reserved = new Uint8Array(grid.W * grid.H);
  const standing = new Uint8Array(grid.W * grid.H);
  // Every tile's anchor, whatever the streets do.
  //
  // The anchor is where the nav graph says a body may stand to serve the seams
  // a tile carries, and validation checks that it really is standing room, so
  // it is macro skeleton in exactly the way a street is. It is marked as
  // STANDING room rather than merely reserved, which is the stronger of the two
  // and costs a ring of berth around it: a segment may be declared whenever one
  // of its two cells is buildable, so reserving only the cell would still let a
  // builder wall that cell's edge, half a cell from a point that has to stay
  // clear. Paying for that ring in `buildableCells` rather than by reserving
  // five cells per tile leaves the blocks between anchors whole.
  const berth = Math.max(params.contestantRadius, params.hunterRadius);
  for (const tile of tiles) {
    // Every cell the anchor's clearance disc touches, which is not the same as
    // the cell it floors into: an anchor often lands exactly on a lattice
    // corner, where it belongs to four cells at once and to none of them in
    // particular. Reserving the floored cell alone left a wall run ending
    // exactly on such an anchor, which is a distance of zero.
    for (
      let y = Math.floor(tile.anchor.y - berth);
      y <= Math.floor(tile.anchor.y + berth);
      y += 1
    )
      for (
        let x = Math.floor(tile.anchor.x - berth);
        x <= Math.floor(tile.anchor.x + berth);
        x += 1
      ) {
        if (x < 0 || y < 0 || x >= grid.W || y >= grid.H) continue;
        reserved[y * grid.W + x] = 1;
        standing[y * grid.W + x] = 1;
      }
  }
  for (const corridor of corridors)
    for (const point of corridor.points) {
      const x0 = Math.max(0, Math.floor(point.x - STREET_REACH)),
        x1 = Math.min(grid.W - 1, Math.ceil(point.x + STREET_REACH)),
        y0 = Math.max(0, Math.floor(point.y - STREET_REACH)),
        y1 = Math.min(grid.H - 1, Math.ceil(point.y + STREET_REACH));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          if (
            Math.abs(x + 0.5 - point.x) <= STREET_REACH &&
            Math.abs(y + 0.5 - point.y) <= STREET_REACH
          )
            reserved[y * grid.W + x] = 1;
    }
  return { corridors, reserved, standing, legs: corridors.length };
}

/**
 * Props that reach into a street, dropped.
 *
 * Reservation stops a builder placing a prop in a lane cell, but a prop in the
 * cell beside one still reaches a little way out of it, and a street only as
 * wide as the body using it has nothing to spare. The guard in
 * `micro/clearance.ts` cannot help here: it drops walls, which are the only
 * thing that can sever a route inside a block, and a prop pinching a street is
 * a whole-map fact no single block can see.
 */
export function clearStreets(
  obstacles: Wall[],
  corridors: ReservedCorridor[],
): Wall[] {
  if (!corridors.length) return obstacles;
  return obstacles.filter((prop) => {
    for (const corridor of corridors)
      for (let leg = 0; leg + 1 < corridor.points.length; leg++) {
        const a = corridor.points[leg]!,
          b = corridor.points[leg + 1]!;
        if (
          segmentSegmentDistance(
            prop.x1,
            prop.y1,
            prop.x2,
            prop.y2,
            a.x,
            a.y,
            b.x,
            b.y,
          ) < corridor.radius
        )
          return false;
      }
    return true;
  });
}

/**
 * The parts of a region a builder may actually build on.
 *
 * The streets running through a region are not its builder's to touch, and what
 * they cut it into are separate places: a block on one side of a street is not
 * the same yard as the block on the other. So a builder is handed a block, not
 * a region. Splitting here rather than inside every builder keeps `mask.rects`,
 * `mask.interior` and the clearance flood all describing the same buildable
 * area -- without it a builder sites a building across a street, every cell of
 * it is refused, and the builder silently produces nothing.
 */
function buildableBlocks(
  region: MapRegion,
  grid: GridBuild,
  reserved: (x: number, y: number) => boolean,
): number[][] {
  const { W, H, segmentOpen, segmentIndex } = grid;
  const open = new Set<number>();
  for (const cell of region.cells) {
    const x = cell % W;
    if (!reserved(x, (cell - x) / W)) open.add(cell);
  }
  const clear = (index: number) => {
    const span = segmentOpen[index];
    return !!span && span[0] <= SPAN_EPS && span[1] >= 1 - SPAN_EPS;
  };
  const blocks: number[][] = [];
  const seen = new Set<number>();
  // Ascending cell order throughout, so which cell seeds a block -- and so the
  // block's seed -- is a function of the shape and nothing else.
  for (const start of [...open].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const queue = [start],
      members: number[] = [];
    seen.add(start);
    while (queue.length) {
      const at = queue.pop()!;
      members.push(at);
      const x = at % W,
        y = (at - x) / W;
      const step = (nx: number, ny: number, segment: number) => {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
        const next = ny * W + nx;
        if (seen.has(next) || !open.has(next) || !clear(segment)) return;
        seen.add(next);
        queue.push(next);
      };
      step(x - 1, y, segmentIndex(true, x, y));
      step(x + 1, y, segmentIndex(true, x + 1, y));
      step(x, y - 1, segmentIndex(false, y, x));
      step(x, y + 1, segmentIndex(false, y + 1, x));
    }
    members.sort((a, b) => a - b);
    blocks.push(members);
  }
  return blocks;
}

/**
 * Micro generation: one builder pass per discovered region.
 *
 * Regions are discovered twice, and the difference matters. The first search
 * finds the *build* regions: the areas a builder owns and is handed. A builder
 * may then repaint cells and state segments inside its own area, which is what
 * makes a wall, a door, a window or a pillar expressible at all -- but it also
 * means the partition those regions came from no longer describes the composed
 * result. So `generateMap` searches again afterwards and the artifact carries
 * that second partition, which agrees with the cells by construction. A
 * compound's rooms are separate regions in the artifact because the walls the
 * builder stated genuinely separate them.
 *
 * The macro parameters a builder needs are passed in rather than looked up: a
 * candidate carries the loot density of the tier zone covering its cell, so a
 * region straddling a zone boundary is handled without deciding which zone it
 * "belongs" to. The class rule supplies only what is intrinsic to the class.
 */
export interface MicroResult {
  spawns: Array<{ cell: number; kind: string }>;
  obstacles: Wall[];
  features: Array<{ kind: string; x: number; y: number }>;
  /** The builder that owned each cell, by cell index; "" where none ran. */
  ownerOf: string[];
  /** False where the clearance guard had to drop a declaration to keep a route. */
  honored: Uint8Array;
  /** What the builders actually declared, which is the thing worth counting. */
  declared: { cells: number; segments: number; blocks: number };
}

/**
 * The boundary segments a region is currently reachable through. The widest
 * opening onto each neighbouring region is marked required: losing it would
 * strand that neighbour, and a builder has no way to know that from inside.
 */
function regionOpenings(
  mask: RegionMask,
  grid: GridBuild,
  regionOf: Int32Array,
): RegionOpening[] {
  const { W, H, cellClass, segmentOpen, segmentIndex } = grid;
  const found: RegionOpening[] = [];
  const widest = new Map<number, number>();
  for (const cell of mask.cells) {
    const steps: Array<[number, number, boolean, number, number]> = [
      [cell.x - 1, cell.y, true, cell.x, cell.y],
      [cell.x + 1, cell.y, true, cell.x + 1, cell.y],
      [cell.x, cell.y - 1, false, cell.y, cell.x],
      [cell.x, cell.y + 1, false, cell.y + 1, cell.x],
    ];
    for (const [nx, ny, vertical, line, offset] of steps) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (mask.has(nx, ny)) continue;
      const outsideIndex = ny * W + nx;
      if (cellClass[outsideIndex] === OUTSIDE_CLASS) continue;
      const span = segmentOpen[segmentIndex(vertical, line, offset)];
      if (!span) continue;
      const width = span[1] - span[0];
      if (width <= SPAN_EPS) continue;
      const neighbour = regionOf[outsideIndex]!;
      widest.set(neighbour, Math.max(widest.get(neighbour) ?? 0, width));
      found.push({
        vertical,
        line,
        offset,
        inside: { cellIndex: cell.cellIndex, x: cell.x, y: cell.y },
        outside: { cellIndex: outsideIndex, x: nx, y: ny },
        width,
        required: false,
      });
    }
  }
  // Exactly one opening onto each neighbour is required, so a builder keeps
  // every neighbour reachable while still being free to narrow the rest into
  // doors and squeezes. Ties break on the lowest cell index, for determinism.
  const claimed = new Set<number>();
  for (const opening of found) {
    const neighbour = regionOf[opening.outside.cellIndex]!;
    if (claimed.has(neighbour)) continue;
    if (opening.width < (widest.get(neighbour) ?? 0) - SPAN_EPS) continue;
    opening.required = true;
    claimed.add(neighbour);
  }
  return found;
}

export function generateMicro(
  regions: MapRegion[],
  grid: GridBuild,
  library: Library,
  zones: MapZone[],
  params: MapParams,
  regionOf: Int32Array,
  streets: ReservedCorridor[],
  standing: (x: number, y: number) => boolean,
  reserved: (x: number, y: number) => boolean,
): MicroResult {
  const { W, H } = grid;
  const result: MicroResult = {
    spawns: [],
    obstacles: [],
    features: [],
    ownerOf: new Array<string>(W * H).fill(""),
    honored: new Uint8Array(W * H).fill(1),
    declared: { cells: 0, segments: 0, blocks: 0 },
  };
  const ts = params.tileSize;
  // One axis object serves every region: it describes the tile lattice, which
  // is a property of the map rather than of any area laid over it.
  const axis: GridAxis = {
    tileSize: ts,
    tileOf: (x, y) => ({ col: Math.floor(x / ts), row: Math.floor(y / ts) }),
    tileBounds: (col, row) => [
      col * ts,
      row * ts,
      col * ts + ts - 1,
      row * ts + ts - 1,
    ],
    onTileBorder: (x, y) =>
      x % ts === 0 || y % ts === 0 || x % ts === ts - 1 || y % ts === ts - 1,
    onTileSeam: (ref) => ref.line % ts === 0,
    snap: (value) => Math.round(value / ts) * ts,
  };
  const zoneAt = (x: number, y: number) =>
    zones.find(
      (z) =>
        x >= z.cells[0] &&
        y >= z.cells[1] &&
        x <= z.cells[2] &&
        y <= z.cells[3],
    );

  for (const region of regions) {
    const rule = library.cellClasses?.[region.cellClass] ?? {};
    for (const block of buildableBlocks(region, grid, reserved)) {
      const mask = createMask(block, W, H);
      const blockSeed = hash(`${region.seed}:${block[0]}`);
      const candidates = mask.lattice(2, 1, 1).map((c) => ({
        cellIndex: c.cellIndex,
        x: c.x,
        y: c.y,
        lootChance: zoneAt(c.x, c.y)?.lootChance ?? 0,
      }));
      const context: RegionContext = {
        regionId: region.id,
        cellClass: region.cellClass,
        rule,
        seed: blockSeed,
        rng: createRng(blockSeed),
        mask,
        grid: axis,
        params,
        candidates,
        budget: candidates.length,
        isReserved: reserved,
        isStandingRoom: standing,
        openings: regionOpenings(mask, grid, regionOf),
        // The streets crossing this area. A builder may build up to one and not
        // across it, and the clearance guard checks that it did not.
        corridors: streets.filter((corridor) =>
          corridor.points.some((point) =>
            mask.has(Math.floor(point.x), Math.floor(point.y)),
          ),
        ),
        clearance: {
          contestant: params.contestantRadius,
          hunter: params.hunterRadius,
        },
        zoneAt: (x, y) => {
          const zone = zoneAt(x, y);
          return {
            tier: zone?.tier ?? 1,
            bonus: zone?.bonus ?? 0,
            lootChance: zone?.lootChance ?? 0,
          };
        },
      };
      const builder = builderFor(rule, mask.area);
      const edit = builder.build(context);

      for (const cell of edit.cells) {
        if (cell.class !== undefined)
          grid.cellClass[cell.cellIndex] = cell.class;
        if (cell.height !== undefined)
          grid.cellLevel[cell.cellIndex] = cell.height;
      }
      for (const segment of edit.segments)
        grid.segmentOpen[
          grid.segmentIndex(
            segment.ref.vertical,
            segment.ref.line,
            segment.ref.offset,
          )
        ] = segment.open;
      for (const vertex of edit.vertices)
        grid.vertices.set(vertex.y * (W + 1) + vertex.x, {
          class: vertex.class ?? ANY_CLASS,
          height: vertex.height ?? "any",
        });
      result.declared.blocks += 1;
      result.declared.cells += edit.cells.length;
      result.declared.segments += edit.segments.length;
      for (const slot of edit.spawns)
        result.spawns.push({ cell: slot.cellIndex, kind: slot.kind });
      result.obstacles.push(...edit.obstacles);
      result.features.push(...edit.features);
      for (const cell of mask.cells) {
        result.ownerOf[cell.cellIndex] = edit.manifest.generator;
        if (!edit.manifest.corridorsHonored) result.honored[cell.cellIndex] = 0;
      }
    }
  }
  result.obstacles = clearStreets(result.obstacles, streets);
  // A builder may have turned a cell to material after a spawn was offered on
  // it. Nothing may stand in material, so the spawn goes rather than the wall.
  result.spawns = result.spawns
    
    .sort((a, b) => a.cell - b.cell);
  return result;
}

/** Every cell an arbitrary segment passes through, walked exactly. */
export function cellsCrossed(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number[][] {
  const cells: number[][] = [];
  let cx = Math.floor(x1),
    cy = Math.floor(y1);
  const lastX = Math.floor(x2),
    lastY = Math.floor(y2);
  const dx = x2 - x1,
    dy = y2 - y1;
  const stepX = Math.sign(dx),
    stepY = Math.sign(dy);
  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tMaxX =
    dx === 0 ? Infinity : Math.abs(((stepX > 0 ? cx + 1 : cx) - x1) / dx);
  let tMaxY =
    dy === 0 ? Infinity : Math.abs(((stepY > 0 ? cy + 1 : cy) - y1) / dy);
  cells.push([cx, cy]);
  for (let guard = 0; guard < 4096; guard++) {
    if (cx === lastX && cy === lastY) break;
    if (tMaxX < tMaxY) {
      if (tMaxX > 1) break;
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      if (tMaxY > 1) break;
      cy += stepY;
      tMaxY += tDeltaY;
    }
    cells.push([cx, cy]);
  }
  return cells;
}

/** Cached readers over a map's coded grids, so callers never decode by hand. */
export interface GridViews {
  width: number;
  height: number;
  verticalCount: number;
  cellClass: (index: number) => string;
  /** The layout's own classes, `any` kept. The final classes on a map with no layout. */
  layoutClass: (index: number) => string;
  /** The layout's classes with `any` filled in: the planned layout's own on a planned map, the final classes on a map with neither. */
  filledClass: (index: number) => string;
  /** Segment-indexed seam constraints; `any` throughout on a map with no structure. */
  constraints: (index: number) => string;
  cellLevel: (index: number) => number;
  segmentOpen: (index: number) => Span;
  /** Explicit vertex metadata; anything absent defers and is flat. */
  vertices: Map<number, VertexMeta>;
  spawns: Map<number, string>;
}
export function gridViews(map: GeneratedMap): GridViews {
  const cached = viewCaches.get(map);
  if (cached) return cached;
  const grid = map.grid;
  const readClass = gridReader(grid.cells.class);
  const layoutCells = (map.layout ?? map.plannedLayout)?.grid.cells.class;
  const views: GridViews = {
    width: grid.width,
    height: grid.height,
    verticalCount: (grid.width + 1) * grid.height,
    cellClass: readClass,
    layoutClass: layoutCells ? gridReader(layoutCells) : readClass,
    // A planned layout states every cell, so there is nothing to fill in.
    filledClass: map.structure
      ? gridReader(map.structure.cells.class)
      : layoutCells ? gridReader(layoutCells) : readClass,
    constraints: map.structure ? gridReader(map.structure.segments.constraints) : () => "any",
    cellLevel: grid.cells.level ? gridReader(grid.cells.level) : () => 0,
    segmentOpen: gridReader(grid.segments.open),
    vertices: new Map(
      grid.vertices.map((entry) => [
        entry.vertex,
        {
          class: entry.class ?? ANY_CLASS,
          height: entry.height ?? ("any" as number | "any"),
        },
      ]),
    ),
    spawns: new Map(grid.cells.spawns.map((s) => [s.cell, s.kind])),
  };
  viewCaches.set(map, views);
  return views;
}
/** A cell the layout left `any` and structure filled in from a neighbour's edge: the Map Lab stripes it. */
export function filledIn(views: GridViews, index: number): boolean {
  return views.layoutClass(index) === "any" && views.filledClass(index) !== "open";
}
/** How much the Map Lab's structure overlays have to draw. */
export function overlayCounts(views: GridViews): { filledCells: number; constrainedSegments: number } {
  let filledCells = 0,
    constrainedSegments = 0;
  for (let i = 0; i < views.width * views.height; i++) if (filledIn(views, i)) filledCells += 1;
  const segments = views.verticalCount + (views.height + 1) * views.width;
  for (let i = 0; i < segments; i++) if (views.constraints(i) !== "any") constrainedSegments += 1;
  return { filledCells, constrainedSegments };
}
/** Index of the cell at map coordinates, or -1 when outside the grid. */
export function cellIndexAt(map: GeneratedMap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= map.grid.width || y >= map.grid.height) return -1;
  return y * map.grid.width + x;
}
/** Index of one segment; `line` is its constant coordinate. */
export function segmentIndexAt(
  map: GeneratedMap,
  vertical: boolean,
  line: number,
  offset: number,
): number {
  const { width, verticalCount } = gridViews(map);
  return vertical
    ? offset * (width + 1) + line
    : verticalCount + line * width + offset;
}
/** A cell as a plain object; null when no tile covers it. */
export function readCell(map: GeneratedMap, index: number): MapCell | null {
  const views = gridViews(map);
  if (index < 0 || index >= views.width * views.height) return null;
  const cellClass = views.cellClass(index);
  if (cellClass === OUTSIDE_CLASS) return null;
  const kind = views.spawns.get(index);
  return {
    x: index % views.width,
    y: Math.floor(index / views.width),
    cellClass,
    blocked: false,
    height: views.cellLevel(index),
    spawn: kind === undefined ? null : { kind },
  };
}
/** The zone a placed tile belongs to. */
export function tileZone(map: GeneratedMap, tile: MaskCell): MapZone | null {
  return map.zones.find((z) => z.id === tile.zoneId) ?? null;
}

/**
 * The barrier geometry a lattice of cells and segments implies.
 *
 * Read back rather than stored, so what a body meets can never drift from what
 * the primitives say. It is factored out of `deriveWalls` because the street
 * planner needs the same answer before any artifact exists to read it off.
 */
export function wallsFromLattice(
  W: number,
  H: number,
  classAt: (index: number) => string,
  spanAt: (vertical: boolean, line: number, offset: number) => Span,
): Wall[] {
  const occupied = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < W && y < H && classAt(y * W + x) !== OUTSIDE_CLASS;
  const pieces: Wall[] = [];
  const addClosed = (
    vertical: boolean,
    line: number,
    offset: number,
    span: Span,
  ) => {
    const runs: Array<[number, number]> = span
      ? [
          [offset, offset + span[0]],
          [offset + span[1], offset + 1],
        ]
      : [[offset, offset + 1]];
    for (const [lo, hi] of runs) {
      if (hi - lo < SPAN_EPS) continue;
      pieces.push(
        vertical
          ? { x1: line, y1: lo, x2: line, y2: hi }
          : { x1: lo, y1: line, x2: hi, y2: line },
      );
    }
  };
  for (let line = 0; line <= W; line++)
    for (let offset = 0; offset < H; offset++) {
      if (!occupied(line - 1, offset) && !occupied(line, offset)) continue;
      const span = spanAt(true, line, offset);
      if (span && span[0] <= SPAN_EPS && span[1] >= 1 - SPAN_EPS) continue;
      addClosed(true, line, offset, span);
    }
  for (let line = 0; line <= H; line++)
    for (let offset = 0; offset < W; offset++) {
      if (!occupied(offset, line - 1) && !occupied(offset, line)) continue;
      const span = spanAt(false, line, offset);
      if (span && span[0] <= SPAN_EPS && span[1] >= 1 - SPAN_EPS) continue;
      addClosed(false, line, offset, span);
    }
  return mergeRuns(pieces);
}

/**
 * The final navigation walls: the closed part of each segment that touches a
 * laid-out cell, merged into runs, then every prop micro placed. On a map with
 * interiors the lattice is the final grid, layout plus interiors, and the props
 * are the interiors'. Geometry is never stored — it follows from the
 * primitives, so one implementation serves both generation and reading an
 * artifact back.
 */
export function deriveWalls(map: GeneratedMap): Wall[] {
  const views = gridViews(map);
  const { width: W, height: H } = map.grid;
  const walls = wallsFromLattice(
    W,
    H,
    (index) => views.cellClass(index),
    (vertical, line, offset) =>
      views.segmentOpen(segmentIndexAt(map, vertical, line, offset)),
  );
  // Micro props are collidable but off-lattice, so they join the wall list
  // rather than the segment grid.
  if (map.interiors) for (const entry of map.interiors.regions) walls.push(...entry.props);
  else for (const region of map.regions) walls.push(...region.obstacles);
  return walls;
}

/**
 * Every seam the laid-out geometry leaves walkable, in tile order. Like
 * `deriveWalls`, this is read back out of the primitives rather than stored, so
 * the reported graph can never drift from the geometry a body actually meets.
 */
export function deriveEdges(map: GeneratedMap): MapEdge[] {
  const views = gridViews(map);
  const s = map.params.tileSize;
  const at = new Map(map.tiles.map((t) => [key(t.x, t.y), t]));
  const read = (vertical: boolean, line: number, offset: number) =>
    views.segmentOpen(segmentIndexAt(map, vertical, line, offset));
  const edges: MapEdge[] = [];
  for (const t of map.tiles)
    for (const [dx, dy] of [
      [s, 0],
      [0, s],
    ] as const) {
      const other = at.get(key(t.x + dx, t.y + dy));
      if (!other) continue;
      const width = seamOpening(read, t, other, s);
      if (width <= SPAN_EPS) continue;
      edges.push({ a: t.id, b: other.id, width, kind: seamKind(width) });
    }
  return edges;
}

export function canOccupy(
  map: GeneratedMap,
  x: number,
  y: number,
  radius: number,
): boolean {
  if (![x, y, radius].every(Number.isFinite) || radius < 0) return false;
  let index = tileCaches.get(map);
  if (!index) {
    index = new Set(
      map.tiles.map((t) =>
        key(t.x / map.params.tileSize, t.y / map.params.tileSize),
      ),
    );
    tileCaches.set(map, index);
  }
  if (
    !index.has(
      key(
        Math.floor(x / map.params.tileSize),
        Math.floor(y / map.params.tileSize),
      ),
    )
  )
    return false;
  return pointClear(map, x, y, radius);
}

/** Lattice nodes a tile's anchor can reach without leaving that tile. */
function tileReach(map: GeneratedMap, i: number, radius: number): Set<number> {
  let byRadius = reachCaches.get(map);
  if (!byRadius) {
    byRadius = new Map();
    reachCaches.set(map, byRadius);
  }
  let perTile = byRadius.get(radius);
  if (!perTile) {
    perTile = new Array<Set<number> | undefined>(map.tiles.length);
    byRadius.set(radius, perTile);
  }
  if (!perTile[i]) {
    const t = map.tiles[i]!,
      s = map.params.tileSize;
    perTile[i] = reachable(map, radius, t.anchor?.x, t.anchor?.y, [
      t.x,
      t.y,
      t.x + s,
      t.y + s,
    ]);
  }
  return perTile[i]!;
}
/**
 * Every lattice node on the seam two tiles share. Nothing centres an opening
 * any more — a tile may leave its gap anywhere along a side — so passability is
 * tested against the whole seam rather than against its midpoint, which with
 * emergent geometry is as likely to be wall as opening.
 */
function seamNodes(map: GeneratedMap, a: PlacedTile, b: PlacedTile): number[] {
  const s = map.params.tileSize;
  const vertical = a.y === b.y;
  const line = vertical ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  const base = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
  const out: number[] = [];
  for (let step = 0; step <= s / LATTICE_STEP; step++) {
    const along = base + step * LATTICE_STEP;
    const node = vertical
      ? nodeIndex(map, line, along)
      : nodeIndex(map, along, line);
    if (node >= 0) out.push(node);
  }
  return out;
}
function navGraph(map: GeneratedMap, agent: Agent): Map<string, string[]> {
  const radius =
    agent === "hunter" ? map.params.hunterRadius : map.params.contestantRadius;
  let cache = navCaches.get(map);
  if (!cache) {
    cache = { byId: new Map(map.tiles.map((t, i) => [t.id, i])) };
    navCaches.set(map, cache);
  }
  const existing = cache[agent];
  if (existing) return existing;
  const byId = cache.byId;
  const graph = new Map<string, string[]>(map.tiles.map((t) => [t.id, []]));
  for (const e of map.edges) {
    if (!(e.width >= radius * 2)) continue;
    const ia = byId.get(e.a),
      ib = byId.get(e.b);
    if (ia === undefined || ib === undefined) continue;
    const fromA = tileReach(map, ia, radius),
      fromB = tileReach(map, ib, radius);
    if (
      !seamNodes(map, map.tiles[ia]!, map.tiles[ib]!).some(
        (node) => fromA.has(node) && fromB.has(node),
      )
    )
      continue;
    graph.get(e.a)!.push(e.b);
    graph.get(e.b)!.push(e.a);
  }
  cache[agent] = graph;
  return graph;
}
export function findPath(
  map: GeneratedMap,
  fromTileId: string,
  toTileId: string,
  agent: Agent = "contestant",
): string[] {
  const graph = navGraph(map, agent);
  if (!graph.has(fromTileId) || !graph.has(toTileId)) return [];
  const q = [fromTileId],
    prev = new Map<string, string | null>([[fromTileId, null]]);
  while (q.length) {
    const a = q.shift()!;
    if (a === toTileId) break;
    for (const b of graph.get(a) ?? [])
      if (!prev.has(b)) {
        prev.set(b, a);
        q.push(b);
      }
  }
  if (!prev.has(toTileId)) return [];
  const out: string[] = [];
  for (let x: string | null = toTileId; x !== null; x = prev.get(x) ?? null)
    out.push(x);
  return out.reverse();
}

/**
 * The tuning metrics a finished map's geometry supports, read back off the
 * walls, seams, regions and features it actually has rather than carried over
 * from whatever produced it. Call it once `walls` and `edges` are derived.
 *
 * A route that does not exist is `Infinity`, never zero: zero is what an
 * adjacent exit looks like, and the two are opposites.
 */
export function measureMap(map: GeneratedMap): void {
  const m = map.metrics;
  const size = map.params.tileSize;
  m.interiorWalls = map.walls.filter(
    (w) =>
      (w.x1 === w.x2 && w.x1 % size !== 0) ||
      (w.y1 === w.y2 && w.y1 % size !== 0),
  ).length;
  const views = gridViews(map);
  let solid = 0,
    inside = 0;
  for (let i = 0; i < views.width * views.height; i++) {
    const cellClass = views.cellClass(i);
    if (cellClass === OUTSIDE_CLASS) continue;
    inside++;
    if (cellClass === SOLID_CLASS) solid++;
  }
  m.solidFraction = solid / Math.max(1, inside);
  m.regionCount = map.regions.length;
  m.largestRegion = map.regions.reduce(
    (best, r) => Math.max(best, r.cells.length),
    0,
  );
  m.obstacleCount = map.regions.reduce((n, r) => n + r.obstacles.length, 0);

  const placed = new Set(map.tiles.map((t) => key(t.x, t.y)));
  let adjacentPairs = 0;
  for (const t of map.tiles) {
    if (placed.has(key(t.x + size, t.y))) adjacentPairs++;
    if (placed.has(key(t.x, t.y + size))) adjacentPairs++;
  }
  m.sealedSeams = adjacentPairs - map.edges.length;
  const degree = new Map<string, number>(map.tiles.map((t) => [t.id, 0]));
  for (const e of map.edges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  // A tile-graph leaf, which is not the same thing as a geometric cul-de-sac.
  m.deadEnds = [...degree.values()].filter((d) => d === 1).length;
  // A seam a contestant can cross and a hunter cannot, proven on the lattice
  // rather than read off the width's name.
  const contestant = navGraph(map, "contestant"),
    hunter = navGraph(map, "hunter");
  m.squeezes = map.edges.filter(
    (e) =>
      contestant.get(e.a)?.includes(e.b) && !hunter.get(e.a)?.includes(e.b),
  ).length;

  // Route metrics are measured on the coarse tile graph behind findPath, which
  // can miss a route the lattice proves (README, "Reachability is validated
  // against that lattice"), so a valid map may still have none to measure.
  // Each is then Infinity -- never NaN, never a placeholder -- and
  // unroutedExits says how many exits the contestant graph could not reach.
  const spawn = map.features.find((f) => f.kind === "spawn");
  const exits = map.features.filter((f) => f.kind === "exit");
  const distance = (to: string, agent: Agent) => {
    const path = spawn ? findPath(map, spawn.tileId, to, agent) : [];
    return path.length ? (path.length - 1) * size : Infinity;
  };
  const ratio = (a: number, b: number) =>
    Number.isFinite(a) && Number.isFinite(b) ? a / Math.max(1, b) : Infinity;
  const exitDistances = exits.map((e) => distance(e.tileId, "contestant"));
  m.unroutedExits = exitDistances.filter((d) => !Number.isFinite(d)).length;
  const exit = exits[0];
  m.contestantDistance = exitDistances[0] ?? Infinity;
  m.hunterDistance = exit ? distance(exit.tileId, "hunter") : Infinity;
  const from = map.tiles.find((t) => t.id === spawn?.tileId),
    to = map.tiles.find((t) => t.id === exit?.tileId);
  m.detourRatio = ratio(
    m.contestantDistance,
    Math.abs((to?.x ?? 0) - (from?.x ?? 0)),
  );
  // Finite only when every exit has a route: a spread over some of them would
  // describe a different set of exits from one map to the next.
  m.exitCostSpread = exitDistances.length
    ? ratio(Math.max(...exitDistances), Math.min(...exitDistances))
    : Infinity;
  m.hunterToContestantRatio = ratio(m.hunterDistance, m.contestantDistance);
}

export function validateMap(input: unknown): ValidationResult {
  const map = input as GeneratedMap;
  const errors: string[] = [];
  tileCaches.delete(map);
  navCaches.delete(map);
  reachCaches.delete(map);
  viewCaches.delete(map);
  if (map && typeof map === "object") clearNavCache(map);
  if (!map || (map.version !== 1 && map.version !== 2)) errors.push("map.version must be 1 or 2");
  if (
    !Array.isArray(map?.tiles) ||
    !Array.isArray(map?.walls) ||
    !Array.isArray(map?.edges) ||
    !Array.isArray(map?.features) ||
    !map?.grid ||
    !Array.isArray(map?.regions) ||
    !map?.params
  )
    errors.push("map arrays or params missing");
  if (errors.length) return { valid: false, errors };
  const finite = (v: unknown): v is number => Number.isFinite(v),
    p = map.params;
  if (
    ![p.tileSize, p.contestantRadius, p.hunterRadius].every(finite) ||
    p.tileSize !== 6 ||
    p.contestantRadius <= 0 ||
    p.hunterRadius <= 0
  )
    errors.push("invalid params");
  const ids = new Set();
  for (const t of map.tiles) {
    if (
      !t ||
      typeof t.id !== "string" ||
      ids.has(t.id) ||
      ![t.x, t.y, t.col, t.row].every(finite)
    ) {
      errors.push("malformed tile");
      continue;
    }
    ids.add(t.id);
    if (
      !t.anchor ||
      ![t.anchor.x, t.anchor.y].every(finite) ||
      t.anchor.x <= t.x ||
      t.anchor.y <= t.y ||
      t.anchor.x >= t.x + p.tileSize ||
      t.anchor.y >= t.y + p.tileSize
    )
      errors.push(`tile ${t.id} needs a nav anchor inside its own footprint`);
  }
  for (const w of map.walls)
    if (!w || ![w.x1, w.y1, w.x2, w.y2].every(finite))
      errors.push("malformed wall");
  for (const e of map.edges) {
    if (!e || !ids.has(e.a) || !ids.has(e.b))
      errors.push("edge references missing tile");
    if (
      !e ||
      !["door", "wide", "squeeze"].includes(e.kind) ||
      !finite(e.width) ||
      e.width <= 0
    )
      errors.push("malformed edge");
  }
  for (const f of map.features) {
    if (
      !f ||
      typeof f.id !== "string" ||
      ![
        "spawn",
        "hunter-spawn",
        "exit",
        "warp",
        "charger",
        "set-piece",
      ].includes(f.kind) ||
      !ids.has(f.tileId) ||
      ![f.x, f.y].every(finite)
    )
      errors.push("malformed feature");
  }
  const grid = map.grid;
  const cellCount = grid.width * grid.height;
  if (
    !Number.isInteger(grid.width) ||
    !Number.isInteger(grid.height) ||
    grid.width !== map.width ||
    grid.height !== map.height ||
    !Array.isArray(grid.cells?.spawns)
  )
    errors.push("primitive grid does not match the map extent");
  else {
    const segmentCount =
      (grid.width + 1) * grid.height + (grid.height + 1) * grid.width;
    errors.push(
      ...validateGrid(grid.cells.class, "cells.class", cellCount),
      ...(grid.cells.level
        ? validateGrid(grid.cells.level, "cells.level", cellCount)
        : []),
      ...validateGrid(grid.segments.open, "segments.open", segmentCount),
    );
    const vertexCount = (grid.width + 1) * (grid.height + 1);
    if (!Array.isArray(grid.vertices))
      errors.push("vertices must be a list of explicit entries");
    else
      for (const entry of grid.vertices)
        if (
          !entry ||
          !Number.isInteger(entry.vertex) ||
          entry.vertex < 0 ||
          entry.vertex >= vertexCount
        )
          errors.push("vertex metadata refers to no vertex");
    for (const span of grid.segments.open.palette)
      if (
        span !== null &&
        (!Array.isArray(span) ||
          span.length !== 2 ||
          !(span[0]! >= 0) ||
          !(span[1]! <= 1) ||
          !(span[0]! < span[1]!))
      )
        errors.push("segment palette holds an invalid open span");
  }
  if (errors.length) return { valid: false, errors };
  const views = gridViews(map);
  // Every cell a tile laid down belongs to exactly one region.
  let laidOutCells = 0;
  for (let i = 0; i < cellCount; i++)
    if (views.cellClass(i) !== OUTSIDE_CLASS) laidOutCells += 1;
  for (const spawn of grid.cells.spawns) {
    if (
      !Number.isInteger(spawn.cell) ||
      spawn.cell < 0 ||
      spawn.cell >= cellCount ||
      views.cellClass(spawn.cell) === OUTSIDE_CLASS
    )
      errors.push("spawn refers to a cell no tile covers");
    
  }
  // A map with interiors states each region's manifest and props there, naming
  // the final region; the regions view only joins them in.
  const interiorOf = map.interiors
    ? new Map((map.interiors.regions ?? []).map((entry) => [entry?.region, entry]))
    : null;
  if (map.interiors) {
    if (!Array.isArray(map.interiors.regions))
      errors.push("interiors must list their regions");
    else {
      const ids = new Set(map.regions.map((r) => r?.id));
      if (interiorOf!.size !== map.interiors.regions.length)
        errors.push("interiors describe a region twice");
      for (const entry of map.interiors.regions)
        if (!ids.has(entry?.region))
          errors.push(`interiors describe region ${entry?.region}, which the final partition doesn't have`);
    }
  }
  const claimed = new Set<number>();
  for (const r of map.regions) {
    if (!r || !Array.isArray(r.cells)) {
      errors.push("malformed region");
      continue;
    }
    const entry = interiorOf
      ? interiorOf.get(r.id)
      : { manifest: r.manifest, props: r.obstacles };
    if (!entry?.manifest) {
      errors.push(interiorOf ? `region ${r.id} has no interior` : "malformed region");
      continue;
    }
    const { manifest, props } = entry;
    for (const i of r.cells)
      if (!Number.isInteger(i) || i < 0 || i >= cellCount || claimed.has(i))
        errors.push("invalid region cell");
      else claimed.add(i);
    const actual = r.cells.filter((i) => views.spawns.has(i)).length;
    if (actual !== manifest.spawnsPlaced)
      errors.push("region spawn manifest disagrees with cells");
    if (!Array.isArray(props))
      errors.push("region obstacles must be a list");
    else {
      if (props.length !== manifest.obstaclesPlaced)
        errors.push("region obstacle manifest disagrees with its geometry");
      const own = new Set(r.cells);
      for (const o of props) {
        if (![o.x1, o.y1, o.x2, o.y2].every(finite)) {
          errors.push("malformed region obstacle");
          continue;
        }
        // Micro detail need not follow the lattice, but it must stay inside
        // the area that produced it.
        for (const [cx, cy] of cellsCrossed(o.x1, o.y1, o.x2, o.y2))
          if (!own.has(cellIndexAt(map, cx, cy)))
            errors.push(`region ${r.id} placed an obstacle outside itself`);
      }
    }
    if (r.cells.some((i) => views.cellClass(i) !== r.cellClass))
      errors.push("region class disagrees with cells");
  }
  if (claimed.size !== laidOutCells)
    errors.push("regions do not account for every laid-out cell");
  if (errors.length) return { valid: false, errors };
  // Edges report geometry rather than plan it, so every one is re-measured
  // and every opening the tiles left has to be reported. A missing edge would
  // hide a real route from navigation; a surplus one would invent a route.
  {
    const byId = new Map(map.tiles.map((t) => [t.id, t]));
    const read = (vertical: boolean, line: number, offset: number) =>
      views.segmentOpen(segmentIndexAt(map, vertical, line, offset));
    const pairKey = (a: string, b: string) =>
      a < b ? `${a}|${b}` : `${b}|${a}`;
    const reported = new Set<string>();
    for (const e of map.edges) {
      const a = byId.get(e.a),
        b = byId.get(e.b);
      if (!a || !b) continue;
      const gap = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (gap !== p.tileSize || (a.x !== b.x && a.y !== b.y)) {
        errors.push(`edge ${e.a}/${e.b} joins tiles that are not neighbours`);
        continue;
      }
      reported.add(pairKey(a.id, b.id));
      const width = seamOpening(read, a, b, p.tileSize);
      if (Math.abs(width - e.width) > 1e-6)
        errors.push(
          `seam ${a.id}/${b.id} opens ${width} where the edge reports ${e.width}`,
        );
      else if (e.kind !== seamKind(width))
        errors.push(
          `seam ${a.id}/${b.id} opens ${width}, which is not a ${e.kind}`,
        );
    }
    const at = new Map(map.tiles.map((t) => [key(t.x, t.y), t]));
    for (const t of map.tiles)
      for (const [dx, dy] of [
        [p.tileSize, 0],
        [0, p.tileSize],
      ] as const) {
        const other = at.get(key(t.x + dx, t.y + dy));
        if (!other) continue;
        const width = seamOpening(read, t, other, p.tileSize);
        if (width > 1e-9 && !reported.has(pairKey(t.id, other.id)))
          errors.push(
            `seam ${t.id}/${other.id} opens ${width} but no edge reports it`,
          );
      }
  }
  for (const t of map.tiles)
    if (!pointClear(map, t.anchor.x, t.anchor.y, p.contestantRadius))
      errors.push(`tile ${t.id} anchor is inside geometry`);
  // The two things generation still owes, now that it imposes no topology:
  // every tile is walkable, and the run the map exists for can be walked.
  //
  // Both are asked of the geometry itself — one flood of the proven lattice per
  // body, over the whole map — rather than of the tile graph. The tile graph is
  // a coarse view that only ever asks whether one anchor reaches another across
  // a single shared seam without leaving either tile, so a body that walks
  // around through a third tile is invisible to it. That approximation was
  // harmless while a solved topology put a centred aperture in every seam, and
  // is not once a seam carries whatever the designs beside it happen to state.
  const spawn = map.features.find((f) => f.kind === "spawn");
  const hunterSpawn = map.features.find((f) => f.kind === "hunter-spawn");
  const exits = map.features.filter((f) => f.kind === "exit");
  if (!spawn || !exits.length) errors.push("spawn or exits missing");
  else {
    const whole: Box = [0, 0, map.width, map.height];
    const standing = (at: { x: number; y: number }) =>
      nodeIndex(map, at.x, at.y);
    const walkFrom = (agent: Agent, from: { x: number; y: number }) =>
      reachable(
        map,
        agent === "hunter" ? p.hunterRadius : p.contestantRadius,
        from.x,
        from.y,
        whole,
      );
    for (const agent of ["contestant", "hunter"] as Agent[]) {
      const reached = walkFrom(agent, spawn);
      const unreachable = map.tiles.filter(
        (t) => !reached.has(standing(t.anchor)),
      );
      // One message per body, naming a design to look at: a sealed pocket is
      // one fault in the library, not fifty faults in the map.
      if (unreachable.length)
        errors.push(
          `${agent} cannot reach ${unreachable.length} tile${unreachable.length === 1 ? "" : "s"}, starting at ${unreachable[0]!.id} (design ${unreachable[0]!.templateId})`,
        );
      if (agent === "contestant")
        for (const exit of exits)
          if (!reached.has(standing(exit)))
            errors.push(`contestant has no route from the spawn to ${exit.id}`);
    }
    if (!hunterSpawn) errors.push("hunter has no start");
    else {
      const reached = walkFrom("hunter", hunterSpawn);
      for (const exit of exits)
        if (!reached.has(standing(exit)))
          errors.push(`hunter has no route from its spawn to ${exit.id}`);
    }
  }
  return { valid: !errors.length, errors };
}


/**
 * Metrics and validation for a finished map, which is the "Report" layer in
 * docs/DESIGN_DECISIONS.md "Map layers". Every generator ends here, so the
 * numbers mean the same thing whichever one made the map.
 */
export function reportMap(map: GeneratedMap): void {
  measureMap(map);
  map.validation = validateMap(map);
}

/**
 * The regions of a finished grid, each holding the props whose midpoint lies
 * in it. The artifact carries the partition of the composed result, not the
 * one the builders were handed, so this is searched after micro has run. A
 * prop stays inside one cell by contract, so its midpoint names the region
 * that now owns it -- which may not be the one whose builder placed it.
 */
export function partitionFinished(
  grid: Parameters<typeof searchRegions>[0],
  seed: string,
  props: Iterable<Wall>,
): MapRegion[] {
  const regions = searchRegions(grid, seed);
  const regionAt = new Int32Array(grid.W * grid.H).fill(-1);
  regions.forEach((region, index) => {
    for (const cell of region.cells) regionAt[cell] = index;
  });
  for (const wall of props) {
    const cx = Math.floor((wall.x1 + wall.x2) / 2),
      cy = Math.floor((wall.y1 + wall.y2) / 2);
    if (cx < 0 || cy < 0 || cx >= grid.W || cy >= grid.H) continue;
    regions[regionAt[cy * grid.W + cx]!]?.obstacles.push(wall);
  }
  return regions;
}

/** The placement sampler's generator. Each retry attempt starts one step further along. */
function placementRandom(seedText: string, attempt: number): () => number {
  let seedState = 0;
  for (let i = 0; i < seedText.length; i++)
    seedState = Math.imul(seedState ^ seedText.charCodeAt(i), 3432918353);
  seedState += attempt;
  return () => {
    seedState = (seedState + 1831565813) | 0;
    let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a design's anchor lands inside its tile once turned, in cells from the tile's corner. */
function designAnchor(design: TileDesign, deg: number, tileSize: number): Point {
  const anyDesign = design as any;
  if (!anyDesign.anchor) return { x: tileSize / 2, y: tileSize / 2 };
  let ax = anyDesign.anchor.x;
  let ay = anyDesign.anchor.y;
  if (deg === 90) { const t = ax; ax = tileSize - ay; ay = t; }
  else if (deg === 180) { ax = tileSize - ax; ay = tileSize - ay; }
  else if (deg === 270) { const t = ax; ax = ay; ay = tileSize - t; }
  return { x: ax, y: ay };
}

/** The design placement falls back to when a slot names none the library has. */
function fallbackDesign(library: Library): TileDesign {
  return library.tiles.find(t => t.id === "open") || library.tiles.find(t => t.id === "plain") || library.tiles[0]!;
}

/**
 * The tile slots the occupied zones cover, zone by zone. A layout's
 * placements are in this order, so a slot's position is never stored.
 */
export function layoutSlots(p: MapParams): MaskCell[] {
  const cells: MaskCell[] = [];
  for (const zone of makeZones(p)) {
    const [x0, y0, x1, y1] = zone.tiles;
    for (let col = x0; col <= x1; col++)
      for (let row = y0; row <= y1; row++)
        cells.push({ x: col, y: row, col, row, id: `t-${col}-${row}`, zoneId: zone.id });
  }
  return cells;
}

/** JSON with sorted keys, so equal content gives equal text. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(",")}}`;
}

/**
 * Names a library by its content, whatever its key order. A layout names
 * designs by id and structure reads those designs, so a map records this and
 * is only read back with the library it names. Two FNV-1a passes, the second
 * seeded differently, make 64 bits.
 */
export function libraryFingerprint(library: Library): string {
  const text = canonicalJson(library);
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return hex(hash(text)) + hex(hash(`#${text}`));
}

/**
 * One sample of the retry loop: set pieces, then WFC for the rest, then the
 * primitives the chosen designs lay down. Every draw from `random` happens
 * here. A set piece with nowhere to go is reported rather than thrown, so the
 * caller can say which one kept failing; a WFC failure throws.
 */
export function placeLayout(
  seedText: string,
  p: MapParams,
  library: Library,
  random: () => number,
): MapLayout | { failedSetPiece: string } {
  const mode = p.mode;
  const zones = makeZones(p);

  const cells = layoutSlots(p);
  const byKey = new Map(cells.map((c, i) => [key(c.x, c.y), i]));

  const zoneOf = (c: MaskCell) => zones.find((z) => c.x >= z.tiles[0]! && c.x <= z.tiles[2]! && c.y >= z.tiles[1]! && c.y <= z.tiles[3]!)!;

  const assigned = new Array<{
    templateId: string; orientation: number; setPieceId?: string; setPieceInstance?: string;
  } | undefined>(cells.length);

  const fallback = fallbackDesign(library);

  const allLibraryPieces = library.setPieces || [];
  const starts = allLibraryPieces.filter((sp: any) => sp.category === "start");
  const ends = allLibraryPieces.filter((sp: any) => sp.category === "end");
  const enormous = allLibraryPieces.filter((sp: any) => sp.category === "enormous");
  const mediums = allLibraryPieces.filter((sp: any) => sp.category === "medium");
  const smalls = allLibraryPieces.filter((sp: any) => sp.category === "small");

  const activeSetPieces: { piece: any, filter: (anchor: MaskCell, w: number, h: number) => boolean }[] = [];

  if (mode === "game" && starts.length) activeSetPieces.push({ piece: starts[Math.floor(random() * starts.length)], filter: (c) => c.x === 0 });
  if (mode === "game" && ends.length) activeSetPieces.push({ piece: ends[Math.floor(random() * ends.length)], filter: (c, w) => c.x + w >= p.columns });

  const shuffle = (arr: any[]) => [...arr].sort(() => random() - 0.5);
  const chosenEnormous = mode === "game" ? shuffle(enormous).slice(0, 3) : [];
  if (chosenEnormous[0]) activeSetPieces.push({ piece: chosenEnormous[0], filter: (c, w) => c.x > p.columns / 4 && c.x + w < p.columns * 3 / 4 && c.y < p.rows / 3 });
  if (chosenEnormous[1]) activeSetPieces.push({ piece: chosenEnormous[1], filter: (c, w) => c.x > p.columns / 4 && c.x + w < p.columns * 3 / 4 && c.y >= p.rows / 3 && c.y < p.rows * 2 / 3 });
  if (chosenEnormous[2]) activeSetPieces.push({ piece: chosenEnormous[2], filter: (c, w) => c.x > p.columns / 4 && c.x + w < p.columns * 3 / 4 && c.y >= p.rows * 2 / 3 });

  for (let i = 0; mode === "game" && i < 4; i++) {
    if (!mediums.length) break;
    activeSetPieces.push({ piece: mediums[Math.floor(random() * mediums.length)], filter: (c, w) => c.x < p.columns / 3 || c.x + w > p.columns * 2 / 3 });
  }

  for (let i = 0; mode === "game" && i < 10; i++) {
    if (!smalls.length) break;
    activeSetPieces.push({ piece: smalls[Math.floor(random() * smalls.length)], filter: () => true });
  }

  activeSetPieces.sort((a, b) => b.piece.tiles.length - a.piece.tiles.length);

  for (const [pieceIndex, { piece: setPiece, filter }] of activeSetPieces.entries()) {
    if (!setPiece) continue;
    const w = Math.max(...setPiece.tiles.map((s: any) => s.dx)) + 1;
    const h = Math.max(...setPiece.tiles.map((s: any) => s.dy)) + 1;

    const placements: Array<{ i: number; slots: Array<{ s: SetPieceSlot; j: number | undefined }> }> = [];
    for (let i = 0; i < cells.length; i++) {
      const anchor = cells[i]!;
      if (!filter(anchor, w, h)) continue;
      const slots = setPiece.tiles.map((s: any) => ({ s, j: byKey.get(key(anchor.x + s.dx, anchor.y + s.dy)) }));
      if (slots.every((x: any) => x.j !== undefined && setPiece.eligibleTiers.includes(zoneOf(cells[x.j]!).tier) && !assigned[x.j])) {
        placements.push({ i, slots });
      }
    }
    if (!placements.length) return { failedSetPiece: setPiece.id };
    const place = placements[Math.floor(random() * placements.length)]!;
    // Tells one placed copy of a set piece from another. It takes no draw from
    // `random`, so it can't shift anything placed after it.
    const instanceId = `${setPiece.id}#${pieceIndex}`;

    for (const { s, j: slot } of place.slots) {
      const j = slot!;
      const tileSet = library.tileSets?.find((ts) => ts.id === s.tileSetId);
      const memberId = tileSet ? tileSet.members[Math.floor(random() * tileSet.members.length)] : fallback.id;
      const design = library.tiles.find((t) => t.id === memberId) || fallback;
      const orientations = design.orientations && design.orientations.length ? design.orientations : [0];
      const orientation = (s as any).orientation !== undefined ? (s as any).orientation : orientations[Math.floor(random() * orientations.length)];

      assigned[j] = {
        templateId: design.id, orientation,
        setPieceId: setPiece.id,
        setPieceInstance: instanceId,
      };
    }
  }

  const tileOptions: import("./wfc.ts").TileOption[] = library.tiles.flatMap(t =>
    (t.orientations || [0]).map(o => ({
      templateId: t.id,
      orientation: o as any,
      difficulty: getDifficulty(t),
      weight: t.weight || 1,
      id: undefined as any
    }))
  );
  const wfcGrid: WfcGrid = cells.map((c, i) => {
    if (assigned[i]) {
      return {
        x: c.x, y: c.y,
        domain: [{
          weight: 1,
          templateId: assigned[i]!.templateId,
          orientation: assigned[i]!.orientation as any,
          difficulty: 0 // pre-assigned
        }],
        setPieceInstance: assigned[i]!.setPieceInstance
      };
    } else {
      const tier = zoneOf(c).tier;
      const validTiles = library.tiles.filter(t => !t.eligibleTiers || t.eligibleTiers.includes(tier));
      const domain: TileOption[] = [];
      for (const t of validTiles) {
        for (const tOpt of tileOptions) {
          if (tOpt.templateId === t.id) domain.push(tOpt);
        }
      }
      return { x: c.x, y: c.y, domain };
    }
  });

  const cellMap = new Map<string, number>();
  wfcGrid.forEach((c, i) => cellMap.set(`${c.x},${c.y}`, i));
  for (const c of wfcGrid) {
    c.n = cellMap.get(`${c.x},${c.y - 1}`);
    c.s = cellMap.get(`${c.x},${c.y + 1}`);
    c.e = cellMap.get(`${c.x + 1},${c.y}`);
    c.w = cellMap.get(`${c.x - 1},${c.y}`);
    c.tl = cellMap.get(`${c.x - 1},${c.y - 1}`);
    c.tr = cellMap.get(`${c.x + 1},${c.y - 1}`);
    c.bl = cellMap.get(`${c.x - 1},${c.y + 1}`);
    c.br = cellMap.get(`${c.x + 1},${c.y + 1}`);
  }

  const solvedGrid = solveWfc(wfcGrid, p.columns, p.rows, library.tiles, random);
  if (!solvedGrid) {
    throw new Error("WFC Solver could not find a valid tile layout for the macro grid.");
  }

  const slots: MapLayout["placements"] = cells.map((_, i) => {
    const placed = assigned[i];
    if (placed)
      return {
        templateId: placed.templateId,
        orientation: placed.orientation,
        ...(placed.setPieceId ? { setPieceId: placed.setPieceId } : {}),
      };
    const opt = solvedGrid[i]!.domain[0]!;
    const template = library.tiles.find(t => t.id === opt.templateId) || fallback;
    return { templateId: template.id, orientation: opt.orientation };
  });

  const placementsArray: MacroPlacement[] = cells.map((c, i) => {
    const design = library.tiles.find((t) => t.id === slots[i]!.templateId)!;
    return {
      id: c.id, structure: compileTileDesign(design, slots[i]!.orientation as any),
      origin: { x: c.x * p.tileSize, y: c.y * p.tileSize }, orientation: 0,
    } as MacroPlacement;
  });

  const cellMask: Point[] = [];
  for (const c of cells) {
    for (let dy = 0; dy < p.tileSize; dy++) {
      for (let dx = 0; dx < p.tileSize; dx++) { cellMask.push({ x: c.x * p.tileSize + dx, y: c.y * p.tileSize + dy }); }
    }
  }

  const composition = composeMacro({
    version: 1, seed: seedText, width: p.columns * p.tileSize, height: p.rows * p.tileSize,
    mask: cellMask, defaultCellClass: "grass", placements: placementsArray,
  });

  const left = cells.map((c, i) => ({ c, i })).filter((x) => x.c.x < p.columns / 3);
  const right = cells.map((c, i) => ({ c, i })).filter((x) => x.c.x > (p.columns * 2) / 3);
  const spawn = left.reduce((best, x) => (x.c.y > cells[best]!.y ? x.i : best), left[0]!.i);
  const hunter = right.reduce((best, x) => (x.c.x > cells[best]!.x ? x.i : best), right[0]!.i);
  const exits = right.slice(0, p.exitCount).map((x) => x.i);

  return {
    seed: seedText,
    params: p,
    library: libraryFingerprint(library),
    placements: slots,
    grid: {
      width: composition.width,
      height: composition.height,
      cells: { class: encodeGrid(composition.cellClass) },
      segments: { open: encodeGrid(composition.segmentOpen) },
    },
    features: { spawn, hunter, exits },
  };
}

/**
 * Everything derived from a layout that informs micro generation, which is the
 * "Structure" layer in docs/DESIGN_DECISIONS.md "Map layers". `structure` is
 * the part a map keeps; the rest is what micro generation starts from.
 */
export interface DerivedStructure {
  structure: MapStructure;
  zones: MapZone[];
  /** The layout's placements joined with their anchors, in slot order. */
  tiles: PlacedTile[];
  /** The filled-in classes and the layout's segments, decoded for micro to copy. */
  cellClass: string[];
  segmentOpen: Span[];
  /** The regions handed to micro, and which one owns each cell. */
  regions: MapRegion[];
  regionOf: Int32Array;
  streets: StreetPlan;
}

/**
 * Structure from a layout and the library it names designs from. Pure: it
 * draws nothing from placement's generator and reads nothing micro wrote, so
 * two maps with the same layout have the same structure. It runs both when
 * generating and when reading an artifact. It's null when no street network
 * joins the blocks, which sends the retry loop to its next sample.
 */
export function deriveStructure(layout: MapLayout, library: Library): DerivedStructure | null {
  const { params: p, placements: slots } = layout;
  const zones = makeZones(p);
  const cells = layoutSlots(p);
  if (slots.length !== cells.length)
    throw new Error(`layout has ${slots.length} placements for ${cells.length} tile slots`);
  const fallback = fallbackDesign(library);

  // A set piece's tiles stand on their centres; a design placed by WFC may
  // state where its anchor is.
  const tiles: PlacedTile[] = cells.map((c, i) => {
    const slot = slots[i]!;
    const design = library.tiles.find((t) => t.id === slot.templateId) || fallback;
    const anchor = slot.setPieceId
      ? { x: p.tileSize / 2, y: p.tileSize / 2 }
      : designAnchor(design, slot.orientation, p.tileSize);
    return {
      ...c, x: c.x * p.tileSize, y: c.y * p.tileSize,
      templateId: slot.templateId, orientation: slot.orientation,
      anchor: { x: c.x * p.tileSize + anchor.x, y: c.y * p.tileSize + anchor.y },
      ...(slot.setPieceId ? { setPieceId: slot.setPieceId } : {})
    };
  });

  const W = layout.grid.width;
  const H = layout.grid.height;
  const declared = decodeGrid(layout.grid.cells.class);
  const segmentOpen = decodeGrid(layout.grid.segments.open);
  const cellConstraints = new Array(W * H).fill("any");
  const segmentCount = (W + 1) * H + (H + 1) * W;
  const segmentConstraints = new Array(segmentCount).fill("any");

  for (const t of tiles) {
    const opt = { templateId: t.templateId, orientation: t.orientation as any, difficulty: 0, weight: 1 };
    const N = getRotatedEdge(opt, "N", library.tiles);
    const S = getRotatedEdge(opt, "S", library.tiles);
    const E = getRotatedEdge(opt, "E", library.tiles);
    const W_edge = getRotatedEdge(opt, "W", library.tiles);

    for (let i = 0; i < p.tileSize; i++) {
      const vOffset = (W + 1) * H;
      if (N[i] !== "any") {
        const cx = t.x + i; const cy = t.y - 1;
        if (cy >= 0) cellConstraints[cy * W + cx] = N[i];
        const segIdx = vOffset + t.y * W + cx; // horizontal: verticalCount + line(y) * width + offset(x)
        segmentConstraints[segIdx] = N[i];
      }
      if (S[i] !== "any") {
        const cx = t.x + i; const cy = t.y + p.tileSize;
        if (cy < H) cellConstraints[cy * W + cx] = S[i];
        const segIdx = vOffset + (t.y + p.tileSize) * W + cx;
        segmentConstraints[segIdx] = S[i];
      }
      if (E[i] !== "any") {
        const cx = t.x + p.tileSize; const cy = t.y + i;
        if (cx < W) cellConstraints[cy * W + cx] = E[i];
        const segIdx = (t.y + i) * (W + 1) + (t.x + p.tileSize); // vertical: offset(y) * (width + 1) + line(x)
        segmentConstraints[segIdx] = E[i];
      }
      if (W_edge[i] !== "any") {
        const cx = t.x - 1; const cy = t.y + i;
        if (cx >= 0) cellConstraints[cy * W + cx] = W_edge[i];
        const segIdx = (t.y + i) * (W + 1) + t.x;
        segmentConstraints[segIdx] = W_edge[i];
      }
    }
  }

  // A cell that defers is open ground unless a neighbour's edge says otherwise.
  // Regions are searched before that fill, as composition always has.
  const effective = declared.map((c) => (c === "any" ? "open" : c));
  const cellClass = declared.map((c, i) =>
    c === "any" && cellConstraints[i] !== "any" ? cellConstraints[i] : effective[i]!);
  const regions = searchRegions(layoutGrid(W, H, effective, segmentOpen), layout.seed);

  const byKey = new Map(cells.map((c, i) => [key(c.x, c.y), i]));
  const adj: Neighbour[][] = Array.from({ length: cells.length }, () => []);
  const DIRS = [[0, -1, "N", "S"], [1, 0, "E", "W"], [0, 1, "S", "N"], [-1, 0, "W", "E"]] as const;
  for (let i = 0; i < cells.length; i++) {
    for (const [dx, dy, side, opposite] of DIRS) {
      const j = byKey.get(key(cells[i]!.x + dx, cells[i]!.y + dy));
      if (j !== undefined) adj[i]!.push({ j, side, opposite });
    }
  }

  let streets: StreetPlan;
  try {
    streets = planStreets(tiles, adj, layoutGrid(W, H, cellClass, segmentOpen), p, layout.features.spawn, layout.seed);
  } catch {
    return null;
  }

  const regionOf = new Int32Array(W * H).fill(-1);
  regions.forEach((region, index) => {
    for (const cell of region.cells) regionOf[cell] = index;
  });

  const structure: MapStructure = {
    anchors: tiles.map((t) => ({ ...t.anchor })),
    cells: { class: encodeGrid(cellClass) },
    segments: { constraints: encodeGrid(segmentConstraints) },
  };
  return { structure, zones, tiles, cellClass, segmentOpen, regions, regionOf, streets };
}

/** A fresh primitive grid over the given classes and segments, flat and with no stated vertices. */
function layoutGrid(W: number, H: number, cellClass: string[], segmentOpen: Span[]): GridBuild {
  return {
    W, H, cellClass, segmentOpen,
    cellLevel: new Array(W * H).fill(0), vertices: new Map(),
    segmentIndex: (vertical: boolean, line: number, offset: number) =>
      vertical ? offset * (W + 1) + line : (W + 1) * H + line * W + offset,
  };
}

/**
 * What micro generation made over a layout and its structure. `interiors` is
 * the stored "Interiors" layer of docs/DESIGN_DECISIONS.md "Map layers";
 * `micro` keeps the builders' own counts for the report.
 */
export interface GeneratedInteriors {
  interiors: MapInteriors;
  micro: MicroResult;
}

/** Two spans agree when both are barriers or both open the same stretch. */
function sameSpan(a: Span | undefined, b: Span | undefined): boolean {
  return a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
}

/** What `after` states over `before`: `any` wherever the two agree. */
function statedOver<T>(before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean): Array<T | "any"> {
  return after.map((value, i) => (same(before[i]!, value) ? "any" : value));
}

/**
 * The interiors layer from what the builders left: the classes and segments
 * `built` changed over `base`, `any` elsewhere, its levels once the map
 * stops being flat, and the rest as given. Both generators build interiors
 * this way.
 */
export function statedInteriors(
  base: { cellClass: readonly string[]; segmentOpen: readonly Span[] },
  built: { cellClass: readonly string[]; cellLevel: readonly number[]; segmentOpen: readonly Span[] },
  rest: Omit<MapInteriors, "cells" | "segments"> & { spawns: MapInteriors["cells"]["spawns"] },
): MapInteriors {
  const { spawns, ...others } = rest;
  return {
    cells: {
      class: encodeGrid(statedOver(base.cellClass, built.cellClass, (a, b) => a === b)),
      ...(built.cellLevel.some((level) => level !== 0) ? { level: encodeGrid([...built.cellLevel]) } : {}),
      spawns,
    },
    segments: { open: encodeGrid(statedOver(base.segmentOpen, built.segmentOpen, sameSpan)) },
    ...others,
  };
}

/** `base` with every value `stated` gives laid over it. */
function layOver<T>(base: readonly T[], stated: ReadonlyArray<T | "any">): T[] {
  return base.map((value, i) => {
    const over = stated[i];
    return over === "any" || over === undefined ? value : over;
  });
}

/**
 * Micro generation over a layout and its structure. Builders work on copies,
 * so neither input changes, and what they changed is recorded as a statement
 * over the structure's classes and the layout's segments.
 */
export function generateInteriors(
  layout: MapLayout,
  structure: DerivedStructure,
  library: Library,
): GeneratedInteriors {
  const p = layout.params;
  const grid = layoutGrid(layout.grid.width, layout.grid.height, [...structure.cellClass], [...structure.segmentOpen]);
  const { streets } = structure;

  const micro = generateMicro(
    structure.regions, grid, library, structure.zones, p, structure.regionOf, streets.corridors,
    (x, y) => streets.standing[y * grid.W + x] === 1,
    (x, y) => streets.reserved[y * grid.W + x] === 1
  );

  const regions = partitionFinished(grid, layout.seed, micro.obstacles);

  const spawnCells = new Set(micro.spawns.map((s) => s.cell));
  regions.forEach((region) => {
    // Streets are reserved out of every block, so a region's first cell is
    // often one no builder owned. The region names whichever owns most of it.
    // Material a builder laid is a region of its own that nothing builds in,
    // so it names nobody.
    const owned = new Map<string, number>();
    if (region.cellClass !== SOLID_CLASS) for (const cell of region.cells) {
      const owner = micro.ownerOf[cell];
      if (owner) owned.set(owner, (owned.get(owner) ?? 0) + 1);
    }
    let generator = "";
    for (const [owner, count] of owned)
      if (count > (owned.get(generator) ?? 0)) generator = owner;
    region.manifest = {
      ...(generator ? { generator } : {}),
      spawnsPlaced: region.cells.filter((cell) => spawnCells.has(cell)).length,
      obstaclesPlaced: region.obstacles.length,
      corridorsHonored: region.cells.every((cell) => micro.honored[cell] === 1),
    };
  });

  // A builder may site a feature of its own: where a physical exit or a
  // charger stands is a micro detail, per docs/DESIGN_DECISIONS.md. One that
  // lands on no tile is dropped.
  const tileAt = tileAtPoint(structure.tiles, p.tileSize);
  const features: MapInteriors["features"] = [];
  micro.features.forEach((feature, index) => {
    if (!tileAt(feature.x, feature.y)) return;
    features.push({
      id: `micro-${feature.kind}-${index}`,
      kind: feature.kind as MapFeature["kind"],
      x: feature.x + 0.5,
      y: feature.y + 0.5,
    });
  });

  return {
    micro,
    interiors: statedInteriors(structure, grid, {
      spawns: micro.spawns,
      vertices: [...grid.vertices]
        .sort((a, b) => a[0] - b[0])
        .map(([vertex, meta]) => ({
          vertex,
          ...(meta.class === ANY_CLASS ? {} : { class: meta.class }),
          ...(meta.height === "any" ? {} : { height: meta.height }),
        })),
      features,
      regions: regions.map((region) => ({ region: region.id, manifest: region.manifest, props: region.obstacles })),
    }),
  };
}

/** The tile a point stands on, or undefined. */
function tileAtPoint(tiles: PlacedTile[], tileSize: number): (x: number, y: number) => PlacedTile | undefined {
  const at = new Map(tiles.map((t) => [key(t.x, t.y), t]));
  return (x, y) => at.get(key(Math.floor(x / tileSize) * tileSize, Math.floor(y / tileSize) * tileSize));
}

/** Spawn, hunter spawn and exits stand at the anchors of the slots the layout names. */
export function macroFeatures(layout: MapLayout, tiles: PlacedTile[]): MapFeature[] {
  const { spawn, hunter, exits } = layout.features;
  const at = (i: number) => ({ tileId: tiles[i]!.id, x: tiles[i]!.anchor.x, y: tiles[i]!.anchor.y });
  return [
    { id: "spawn", kind: "spawn", ...at(spawn) },
    { id: "hunter-spawn", kind: "hunter-spawn", ...at(hunter) },
    ...exits.map((e, i) => ({ id: `exit-${i}`, kind: "exit" as const, ...at(e) })),
  ];
}

/** Micro's features, each joined with the tile it stands on. */
function microFeatures(interiors: MapInteriors, tiles: PlacedTile[], tileSize: number): MapFeature[] {
  const tileAt = tileAtPoint(tiles, tileSize);
  return interiors.features.map(({ id, ...rest }) => {
    const tile = tileAt(rest.x, rest.y);
    if (!tile) throw new Error(`micro feature ${id} stands on no tile`);
    return { id, ...rest, tileId: tile.id };
  });
}

/**
 * The final primitives and region partition: `baseClass` and `baseOpen` with
 * what interiors state laid over them, then searched for regions, each joined
 * with its interior. Derived, never stored. The final classes and segments come
 * back decoded too, for callers that measure on them.
 */
export function composeInteriors(
  width: number,
  height: number,
  seed: string,
  baseClass: CodedGrid<string>,
  baseOpen: CodedGrid<Span>,
  interiors: MapInteriors,
): { grid: PrimitiveGrid; regions: MapRegion[]; cellClass: string[]; segmentOpen: Span[] } {
  const cellClass = layOver(decodeGrid(baseClass), decodeGrid(interiors.cells.class));
  const segmentOpen = layOver(decodeGrid(baseOpen), decodeGrid(interiors.segments.open));
  const grid: PrimitiveGrid = {
    width,
    height,
    cells: {
      class: encodeGrid(cellClass),
      ...(interiors.cells.level ? { level: interiors.cells.level } : {}),
      spawns: interiors.cells.spawns,
    },
    segments: { open: encodeGrid(segmentOpen) },
    vertices: interiors.vertices,
  };
  const regions = searchRegions(layoutGrid(width, height, cellClass, segmentOpen), seed);
  // A region interiors don't describe keeps an empty manifest, and validation
  // reports it.
  const interiorOf = new Map(interiors.regions.map((entry) => [entry.region, entry]));
  for (const region of regions) {
    const entry = interiorOf.get(region.id);
    if (!entry) continue;
    region.manifest = entry.manifest;
    region.obstacles = entry.props;
  }
  return { grid, regions, cellClass, segmentOpen };
}

/**
 * A V2 map from its layers: the layout, the structure derived from it, and
 * the interiors. Generation and reading an artifact both build the map this
 * way, so the final grid, regions, features and walls are derived the same
 * way in both. The report is the caller's.
 */
export function composeLayers(
  layout: MapLayout,
  structure: DerivedStructure,
  interiors: MapInteriors,
  report: Pick<GeneratedMap, "metrics" | "validation">,
): GeneratedMap {
  const { params: p } = layout;
  const { width: W, height: H } = layout.grid;
  const { tiles, zones } = structure;
  const { grid, regions } = composeInteriors(
    W, H, layout.seed, structure.structure.cells.class, layout.grid.segments.open, interiors,
  );
  const map: GeneratedMap = {
    version: 2, seed: layout.seed, params: p, width: W, height: H, zones, tiles, edges: [], walls: [],
    features: [...macroFeatures(layout, tiles), ...microFeatures(interiors, tiles, p.tileSize)],
    grid,
    regions,
    metrics: report.metrics,
    validation: report.validation,
    layout,
    structure: structure.structure,
    interiors,
  };
  map.edges = deriveEdges(map);
  map.walls = deriveWalls(map);
  return map;
}

/** Today's `GeneratedMap`, composed from the three layers and then reported on. */
function assembleMap(layout: MapLayout, structure: DerivedStructure, generated: GeneratedInteriors): GeneratedMap {
  const { params: p } = layout;
  const { tiles } = structure;
  const { interiors, micro } = generated;
  const map = composeLayers(layout, structure, interiors, {
    // The geometric metrics are placeholders until reportMap reads them off
    // the finished map below.
    metrics: {
      tileCount: tiles.length, deadEnds: 0, squeezes: 0, contestantDistance: 0, hunterDistance: 0, detourRatio: 0,
      regionCount: interiors.regions.length, lootCount: micro.spawns.length, interiorWalls: 0, solidFraction: 0, largestRegion: 0,
      cellCount: tiles.length * p.tileSize * p.tileSize,
      explicitVertices: interiors.vertices.length,
      // Counted rather than inferred from the wall total, so a builder that
      // silently produces nothing shows up here.
      microBlocks: micro.declared.blocks,
      microCells: micro.declared.cells,
      microSegments: micro.declared.segments,
    },
    validation: { valid: true, errors: [] },
  });
  reportMap(map);
  return map;
}

export function generateMap(
  seed: string | number = "last-exit",
  params: Partial<MapParams> = {},
  library: Library = DEFAULT_LIBRARY,
  onProgress?: (status: string, progress: number) => void
): GeneratedMap {
  const seedText = typeof seed === "number" ? seed.toString() : seed;
  const requested = { ...DEFAULT_PARAMS, ...params };
  const p: MapParams = { ...requested, columns: ZONE_COLUMNS * requested.zoneWidth, rows: ZONE_ROWS * requested.zoneHeight };
  const mode = p.mode ?? "game";
  if (mode !== "game" && mode !== "playground")
    throw new Error("map mode must be game or playground");
  p.mode = mode;
  if (mode === "game" && (p.zoneWidth !== 12 || p.zoneHeight !== 6))
    throw new Error("game mode requires 12 x 6 tile zones; choose playground mode for other zone dimensions");
  // A malformed library fails every attempt the same way; the retry loop below
  // is for unlucky samples, so reject it once here instead of fifty times.
  const checkedLibrary = validateLibrary(library);
  if (!checkedLibrary.valid)
    throw new Error(`invalid library: ${checkedLibrary.errors.join("; ")}`);
  if (mode === "game") {
    const pieces = library.setPieces;
    const count = (category: string) => pieces.filter((piece) => piece.category === category).length;
    if (count("start") < 1 || count("end") < 1 || count("enormous") < 3 || count("medium") < 1 || count("small") < 1)
      throw new Error("game mode library requires start, end, at least 3 enormous, medium, and small set pieces");
  }

  const placementFailures = new Map<string, number>();

  for (let attempt = 0; attempt < 50; attempt++) {
    if (onProgress) onProgress(`Attempt ${attempt + 1}/50`, attempt / 50);
    try {
      const layout = placeLayout(seedText, p, library, placementRandom(seedText, attempt));
      if ("failedSetPiece" in layout) {
        const id = layout.failedSetPiece;
        placementFailures.set(id, (placementFailures.get(id) ?? 0) + 1);
        continue;
      }
      const structure = deriveStructure(layout, library);
      if (!structure) continue;
      return assembleMap(layout, structure, generateInteriors(layout, structure, library));
    } catch (e) {
      console.warn("Attempt", attempt, "failed:", (e as Error).stack);
    }
  }

  const placementDetail = [...placementFailures]
    .map(([id, count]) => `${id} (${count}/50 attempts)`)
    .join(", ");
  throw new Error(`V2 Rejection sampling failed to find a walkable placement.${placementDetail ? ` Set piece placement failures: ${placementDetail}.` : ""}`);
}
