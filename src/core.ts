import DEFAULT_LIBRARY_JSON from "../content/default-library.json" with { type: "json" };
import { composeMacro } from "./macro.ts";
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
  type Lattice,
  LATTICE_STEP,
  clearNavCache,
  latticeFor,
  nodeIndex,
  pointClear,
  reachable,
} from "./nav.ts";
import { segmentSegmentDistance } from "./geometry.ts";
import { hasInterior, validateTileShape } from "./tiles.ts";

/** One tile beside another, and the side of each that faces the other. */
interface Neighbour {
  j: number;
  side: Side;
  opposite: Side;
}
import {
  ANY_CLASS,
  SOLID_CLASS,
  isSolidClass,
  SIDES,
  TILE_SIZE,
  widestOpening,
  mergeRuns,
  resolvePrimitives,
  segmentDeclaration,
  sideSegment,
  sideVertex,
  tilePrimitives,
  wallsFrom,
} from "./primitives.ts";
import type {
  ResolvedPrimitives,
  SideContract,
  TilePrimitives,
  VertexMeta,
} from "./primitives.ts";
import { encodeGrid, gridReader, validateGrid } from "./coding.ts";
import type {
  Box,
  GeneratedMap,
  LayoutSlot,
  Library,
  MapCell,
  MapEdge,
  MapFeature,
  MapParams,
  MapRegion,
  MapZone,
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
interface Fitted {
  t: TileDesign;
  deg: number;
  anchor: Point;
  resolved: ResolvedPrimitives;
}
interface Assignment {
  template: TileDesign;
  templateId: string;
  orientation: number;
  anchor: Point;
  resolved: ResolvedPrimitives;
  layoutId?: string;
}
/** A tile fitted to a seam contract: standing room plus frozen primitives. */
interface Fit {
  anchor: Point;
  resolved: ResolvedPrimitives;
}
/** Requirements neighbouring tiles have already placed on shared primitives. */
interface Requirements {
  segments: Map<string, Span>;
  vertices: Map<string, VertexMeta>;
}
export const OUTSIDE_CLASS = "";
const SPAN_EPS = 1e-9;

/** The primitive grids under construction, addressed in map cell coordinates. */
interface GridBuild {
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
const DIRS: Array<[number, number, Side, Side]> = [
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
const fitCaches = new WeakMap<TileDesign, Map<string, Fit | typeof NO_FIT>>();
const portSets = new Map<string, Set<PortKind> | null>();
const viewCaches = new WeakMap<GeneratedMap, GridViews>();
const NO_FIT = Symbol("no-fit");

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: string | number): () => number {
  let x = hash(String(seed)) || 1;
  return () => (
    (x = (x + 0x6d2b79f5) >>> 0),
    (x = Math.imul(x ^ (x >>> 15), x | 1)),
    (x ^= x + Math.imul(x ^ (x >>> 7), x | 61)),
    ((x ^ (x >>> 14)) >>> 0) / 4294967296
  );
}
function key(x: number, y: number): string {
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
/** Does this template accept the zone it would be placed in? */
function acceptsZone(tile: TileDesign, zone: MapZone): boolean {
  return (
    (!tile.eligibleTiers || tile.eligibleTiers.includes(zone.tier)) &&
    (!tile.eligibleBonus || tile.eligibleBonus.includes(zone.bonus))
  );
}
function isAdapter(tile: TileDesign): boolean {
  // A uniform patch is ordinary authored content. Deferring edges describe its
  // adjacency contract, not a lower-priority selection role.
  return tile.adapter === true;
}
/**
 * Every cell class this library declares, plus the reserved material class.
 * A design may only paint a name from this list.
 */
export function cellClassNames(library: Library | null | undefined): string[] {
  return [
    ...new Set([
      ...Object.keys(library?.cellClasses ?? {}),
      SOLID_CLASS,
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
    library.version !== 1 ||
    !Array.isArray(library.tiles) ||
    !library.tiles.length ||
    !Array.isArray(library.tileSets) ||
    !Array.isArray(library.layouts)
  )
    return {
      valid: false,
      errors: [
        "library requires version 1, nonempty tiles, tileSets and layouts arrays",
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
        if (name === SOLID_CLASS || name === ANY_CLASS || !name.trim())
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
    if (t.adapter !== undefined && typeof t.adapter !== "boolean")
      errors.push(`tile ${t.id} adapter must be a boolean`);
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
  const layoutIds = new Set<string>();
  for (const layout of library?.layouts || []) {
    if (!layout || typeof layout !== "object") {
      errors.push("malformed layout");
      continue;
    }
    if (
      !named(layout.id) ||
      layoutIds.has(layout.id) ||
      !named(layout.classId) ||
      !Array.isArray(layout.eligibleTiers) ||
      !Array.isArray(layout.tiles) ||
      !layout.tiles.length
    ) {
      errors.push(`layout ${layout?.id || "?"} is incomplete or duplicated`);
      continue;
    }
    layoutIds.add(layout.id);
    if (
      !layout.eligibleTiers.length ||
      layout.eligibleTiers.some((t) => !Number.isInteger(t) || t < 1 || t > 5)
    )
      errors.push(`layout ${layout.id} needs tiers 1..5`);
    const coords = new Set<string>();
    for (const spot of layout.tiles || []) {
      if (!spot || !Number.isInteger(spot.dx) || !Number.isInteger(spot.dy)) {
        errors.push(`layout ${layout.id} has invalid coordinate`);
        continue;
      }
      const c = key(spot.dx, spot.dy);
      if (coords.has(c)) errors.push(`layout ${layout.id} overlaps at ${c}`);
      coords.add(c);
      if (!sets.has(spot.tileSetId))
        errors.push(
          `layout ${layout.id} references unknown tileSet ${spot.tileSetId}`,
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
 * The tile slots the zones cover. The map boundary is the union of whole zones,
 * so it stair-steps rather than tapering: the notes keep that deliberately,
 * since jagged edges produce alcoves and pockets for free.
 */
function makeMask(zones: MapZone[]): {
  cells: MaskCell[];
  byKey: Map<string, number>;
} {
  const cells: MaskCell[] = [];
  const byKey = new Map<string, number>();
  for (const zone of zones) {
    const [x0, y0, x1, y1] = zone.tiles;
    for (let col = x0; col <= x1; col++)
      for (let row = y0; row <= y1; row++) {
        byKey.set(key(col, row), cells.length);
        cells.push({
          x: col,
          y: row,
          col,
          row,
          id: `t-${col}-${row}`,
          zoneId: zone.id,
        });
      }
  }
  return { cells, byKey };
}

/** Boundary walls and aperture descriptions implied by a solved seam contract. */
/** World keys for primitives two tiles share, so both address the same thing. */
function segmentKey(vertical: boolean, line: number, offset: number): string {
  return `${vertical ? "v" : "h"}:${line}:${offset}`;
}
function sideSegmentWorld(
  tile: { x: number; y: number },
  side: Side,
  i: number,
): [boolean, number, number] {
  if (side === "N") return [false, tile.y, tile.x + i];
  if (side === "S") return [false, tile.y + TILE_SIZE, tile.x + i];
  if (side === "W") return [true, tile.x, tile.y + i];
  return [true, tile.x + TILE_SIZE, tile.y + i];
}
function sideVertexWorld(
  tile: { x: number; y: number },
  side: Side,
  i: number,
): string {
  if (side === "N") return key(tile.x + i, tile.y);
  if (side === "S") return key(tile.x + i, tile.y + TILE_SIZE);
  if (side === "W") return key(tile.x, tile.y + i);
  return key(tile.x + TILE_SIZE, tile.y + i);
}

/**
 * What each side of a placement must provide: only what a neighbour already
 * committed to. Nothing else is asked, so a seam nobody has reached carries no
 * requirement at all and the tile's own declaration stands. Seam geometry is
 * therefore whatever the tiles say it is rather than something laid over them.
 */
function sideContracts(
  origin: { x: number; y: number },
  taken: Requirements,
): Record<Side, SideContract> {
  const out = {} as Record<Side, SideContract>;
  for (const side of SIDES) {
    const segments: Array<Span | undefined> = new Array(TILE_SIZE).fill(
      undefined,
    );
    for (let i = 0; i < TILE_SIZE; i++) {
      const [vertical, line, offset] = sideSegmentWorld(origin, side, i);
      const claimed = taken.segments.get(segmentKey(vertical, line, offset));
      if (claimed !== undefined) segments[i] = claimed;
    }
    const vertices: VertexMeta[] = [];
    for (let i = 0; i <= TILE_SIZE; i++)
      vertices.push(
        taken.vertices.get(sideVertexWorld(origin, side, i)) ?? {
          height: "any",
          class: ANY_CLASS,
        },
      );
    out[side] = { segments, vertices };
  }
  return out;
}
/**
 * Record what a placed tile now requires of its neighbours.
 *
 * Only what it actually states. "any" is the deferring value: it carries no
 * requirement of its own, so a tile that defers on a seam claims nothing there
 * and its neighbour stays free to wall that seam, open it, or defer in turn.
 * Freezing a deferred seam into the clear span it happens to settle at would
 * turn silence into a demand, and no design beside it could ever state a wall.
 */
function claim(
  taken: Requirements,
  origin: { x: number; y: number },
  resolved: ResolvedPrimitives,
  primitives: TilePrimitives,
): void {
  for (const side of SIDES) {
    for (let i = 0; i < TILE_SIZE; i++) {
      const local = sideSegment(side, i);
      if (segmentDeclaration(primitives, local) === "any") continue;
      const [vertical, line, offset] = sideSegmentWorld(origin, side, i);
      taken.segments.set(
        segmentKey(vertical, line, offset),
        resolved.open[local]!,
      );
    }
    for (let i = 0; i <= TILE_SIZE; i++) {
      const meta = resolved.vertices.get(sideVertex(side, i));
      if (!meta) continue;
      taken.vertices.set(sideVertexWorld(origin, side, i), meta);
    }
  }
}
function contractKey(contract: Record<Side, SideContract>): string {
  return SIDES.map((side) => {
    const c = contract[side];
    return (
      c.segments
        .map((s) => (s === undefined ? "?" : s ? `${s[0]}-${s[1]}` : "x"))
        .join(",") +
      "/" +
      c.vertices.map((v) => `${v.class}@${v.height}`).join(",")
    );
  }).join("|");
}

/**
 * Where a body may stand in a template so that every seam it must serve is
 * reachable by a proven route inside the tile. Returns the tile-local anchor,
 * or null when the interior cannot honour this seam contract.
 */
function fitTemplate(
  tile: TileDesign,
  deg: number,
  contract: Record<Side, SideContract>,
  p: MapParams,
): Fit | null {
  let byKey = fitCaches.get(tile);
  if (!byKey) {
    byKey = new Map();
    fitCaches.set(tile, byKey);
  }
  const cacheKey = `${deg}|${contractKey(contract)}|${p.contestantRadius}|${p.hunterRadius}`;
  const cached = byKey.get(cacheKey);
  if (cached !== undefined) return cached === NO_FIT ? null : cached;
  const reject = (): null => {
    byKey!.set(cacheKey, NO_FIT);
    return null;
  };
  const resolved = resolvePrimitives(tilePrimitives(tile, deg), contract);
  if (!resolved) return reject();
  // Each side's aperture, read off the resolved tile rather than off the
  // contract: what a seam carries is now whatever the tiles there declare.
  const open = SIDES.map((side) => sideAperture(resolved, side)).filter(
    (aperture) => aperture.width > SPAN_EPS,
  );
  const local = {
    width: TILE_SIZE,
    height: TILE_SIZE,
    walls: wallsFrom(resolved) as Wall[],
    navBoxes: [[0, 0, TILE_SIZE, TILE_SIZE]] as Box[],
  };
  const box: Box = [0, 0, TILE_SIZE, TILE_SIZE];
  const hunterSides = open.filter(
    (aperture) => aperture.width >= p.hunterRadius * 2,
  );
  const primary = hunterSides.length
    ? { radius: p.hunterRadius, sides: hunterSides }
    : { radius: p.contestantRadius, sides: open };
  let component: Set<number> | null = null;
  if (primary.sides.length) {
    const first = primary.sides[0].mid;
    component = reachable(local, primary.radius, first.x, first.y, box);
    for (const aperture of primary.sides)
      if (!component.has(nodeIndex(local, aperture.mid.x, aperture.mid.y)))
        return reject();
  }
  const lattice = latticeFor(local, p.hunterRadius);
  let anchor: Point | null = null,
    best = Infinity;
  for (let gy = 0; gy < lattice.H; gy++)
    for (let gx = 0; gx < lattice.W; gx++) {
      const i = gy * lattice.W + gx;
      if (!lattice.node[i]) continue;
      if (component && !component.has(i)) continue;
      const x = gx / 2,
        y = gy / 2;
      // Standing room must be inside the tile: an anchor on the seam line
      // would let a sealed interior masquerade as a reachable tile.
      if (x <= 0 || y <= 0 || x >= TILE_SIZE || y >= TILE_SIZE) continue;
      const score = (x - TILE_SIZE / 2) ** 2 + (y - TILE_SIZE / 2) ** 2;
      if (score < best) {
        best = score;
        anchor = { x, y };
      }
    }
  if (!anchor) return reject();
  const fit: Fit = { anchor, resolved };
  // A smaller body clears every move a larger one clears, so the contestant
  // lattice only has to be built when some seam the hunter cannot use is left.
  if (
    hunterSides.length !== open.length ||
    p.contestantRadius > p.hunterRadius
  ) {
    const contestant = reachable(
      local,
      p.contestantRadius,
      anchor.x,
      anchor.y,
      box,
    );
    for (const aperture of open)
      if (!contestant.has(nodeIndex(local, aperture.mid.x, aperture.mid.y)))
        return reject();
  }
  byKey.set(cacheKey, fit);
  return fit;
}

/** The widest opening one side of a resolved tile presents, and its middle. */
function sideAperture(
  resolved: ResolvedPrimitives,
  side: Side,
): { side: Side; width: number; mid: Point } {
  const run = widestOpening(
    Array.from(
      { length: TILE_SIZE },
      (_, i) => resolved.open[sideSegment(side, i)]!,
    ),
  );
  const centre = (run.lo + run.hi) / 2;
  const horizontal = side === "N" || side === "S";
  const line = side === "N" || side === "W" ? 0 : TILE_SIZE;
  return {
    side,
    width: run.width,
    mid: horizontal ? { x: centre, y: line } : { x: line, y: centre },
  };
}

/**
 * Pick a design for one slot. No seam kind is imposed, so nothing filters on
 * `ports`: what a side carries is stated per segment by the tiles themselves.
 *
 * `required` is a hard filter and `prefer` a list of connectivity wishes in
 * descending importance. Reachability is enforced by which design is chosen
 * rather than by cutting an opening into one: a candidate that fails `required`
 * is never placed, and among the rest the draw is restricted to the longest
 * prefix of wishes some candidate can satisfy. When even the first wish cannot
 * be met the slot is still filled and validation reports the result, rather
 * than the generator opening a seam to repair it.
 */
function selectTemplate(
  candidates: TileDesign[],
  random: () => number,
  p: MapParams,
  contract: Record<Side, SideContract>,
  zone?: MapZone,
  prefer: Array<(resolved: ResolvedPrimitives) => boolean> = [],
  required?: (resolved: ResolvedPrimitives) => boolean,
): Fitted | null {
  const matches: Fitted[] = [];
  for (const t of candidates) {
    if (zone && !acceptsZone(t, zone)) continue;
    for (const deg of t.orientations) {
      const fit = fitTemplate(t, deg, contract, p);
      if (!fit) continue;
      if (required && !required(fit.resolved)) continue;
      matches.push({ t, deg, anchor: fit.anchor, resolved: fit.resolved });
    }
  }
  if (!matches.length) return null;
  let pool = matches;
  for (let depth = prefer.length; depth > 0; depth--) {
    const wanted = matches.filter((m) =>
      prefer.slice(0, depth).every((wish) => wish(m.resolved)),
    );
    if (wanted.length) {
      pool = wanted;
      break;
    }
  }
  return pool[Math.floor(random() * pool.length)] ?? null;
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
 * SUPERSEDED, and kept because the legacy generator still depends on it.
 *
 * `src/plan/` replaces this whole idea. Everything below exists because macro
 * had no way to state what it needed, so connectivity had to be defended after
 * the fact: ground reserved from every builder, props dropped, anchors repaired.
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
interface StreetPlan {
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

function planStreets(
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
  // tile index, so the choice follows from the layout and not from iteration.
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
function clearStreets(
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
 * Props that strand a tile anchor, dropped -- and only those.
 *
 * Validation requires that both bodies reach every tile, and a builder is
 * entitled to make ground a hunter cannot cross: that asymmetry is the point of
 * `rubble` and of the body brief behind it. The two meet on one or two tiles a
 * seed, where debris happens to fill a tile's only hunter approach.
 *
 * The blunt fix -- reserving a proven hunter route from every anchor back to
 * the street network, before any builder runs -- was tried and is much worse
 * than it looks. It is a thousand corridors threading the whole map, and
 * `clearStreets` then drops every prop within a body radius of any of them: on
 * a 150 seed sweep it cut collidable detail from ~4,100 a map to 77 and
 * contestant-only squeezes from 271 to none, while every test stayed green. The
 * repair has to be as local as the damage.
 *
 * So it runs after micro generation, measures, and takes back the minimum. A
 * lattice with no props at all says where the hunter could go if micro had
 * placed nothing, which is the guarantee tile selection already gave; the
 * difference against the real geometry is exactly what micro broke. Each
 * stranded anchor then walks back to reachable ground along a route that
 * ignores props, and only the props on that route are dropped. A wall is never
 * touched: the per-block guard owns walls, and a wall that severed a block
 * would already have been taken back.
 */
function reconnectAnchors(
  tiles: PlacedTile[],
  grid: GridBuild,
  params: MapParams,
  from: Point,
  obstacles: Wall[],
): { obstacles: Wall[]; dropped: number; stranded: number } {
  const bareWalls = wallsFromLattice(
    grid.W,
    grid.H,
    (index) => grid.cellClass[index]!,
    (vertical, line, offset) =>
      grid.segmentOpen[grid.segmentIndex(vertical, line, offset)]!,
  );
  const box: Box = [0, 0, grid.W, grid.H];
  const radius = params.hunterRadius;
  const bare: NavTarget = {
    width: grid.W,
    height: grid.H,
    walls: bareWalls,
    navBoxes: [box],
  };
  // Where the hunter could go with no micro geometry at all. Anything outside
  // this was already out of reach and is not micro generation's doing.
  const couldReach = reachable(bare, radius, from.x, from.y, box);
  const lattice = latticeFor(bare, radius);

  let kept = obstacles;
  let dropped = 0,
    stranded = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const full: NavTarget = {
      width: grid.W,
      height: grid.H,
      walls: [...bareWalls, ...kept],
      navBoxes: [box],
    };
    const reaches = reachable(full, radius, from.x, from.y, box);
    // Tile order, so which anchor is repaired first -- and so the result -- is
    // a function of the map and not of iteration.
    const lost = tiles.filter((tile) => {
      const at = nodeIndex(bare, tile.anchor.x, tile.anchor.y);
      return at >= 0 && couldReach.has(at) && !reaches.has(at);
    });
    clearNavCache(full);
    if (!lost.length) return { obstacles: kept, dropped, stranded };
    if (attempt === 0) stranded = lost.length;

    const doomed = new Set<Wall>();
    for (const tile of lost) {
      const route = latticeRouteTo(
        lattice,
        nodeIndex(bare, tile.anchor.x, tile.anchor.y),
        reaches,
      );
      for (const prop of kept) {
        if (doomed.has(prop)) continue;
        for (let leg = 0; leg + 1 < route.length; leg += 1) {
          const a = route[leg]!,
            b = route[leg + 1]!;
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
            ) < radius
          ) {
            doomed.add(prop);
            break;
          }
        }
      }
    }
    if (!doomed.size) break;
    kept = kept.filter((prop) => !doomed.has(prop));
    dropped += doomed.size;
  }
  return { obstacles: kept, dropped, stranded };
}

/** The route from one node to the nearest of a set, on a lattice already built. */
function latticeRouteTo(
  lattice: Lattice,
  start: number,
  goals: ReadonlySet<number>,
): Point[] {
  if (start < 0 || !lattice.node[start]) return [];
  const { W, hEdge, vEdge } = lattice;
  const parent = new Map<number, number>([[start, -1]]);
  const queue = [start];
  let found = goals.has(start) ? start : -1;
  for (let head = 0; head < queue.length && found < 0; head += 1) {
    const at = queue[head]!,
      gx = at % W;
    const step = (next: number) => {
      if (parent.has(next) || found >= 0) return;
      parent.set(next, at);
      if (goals.has(next)) found = next;
      else queue.push(next);
    };
    if (hEdge[at]) step(at + 1);
    if (gx > 0 && hEdge[at - 1]) step(at - 1);
    if (vEdge[at]) step(at + W);
    if (at >= W && vEdge[at - W]) step(at - W);
  }
  if (found < 0) return [];
  const points: Point[] = [];
  for (let at = found; at !== -1; at = parent.get(at)!) {
    const gx = at % W;
    points.push({ x: gx * LATTICE_STEP, y: ((at - gx) / W) * LATTICE_STEP });
  }
  return points.reverse();
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
interface MicroResult {
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

function generateMicro(
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
    // No builder is registered for material: it is discovered and left alone.
    if (isSolidClass(region.cellClass)) continue;
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
    .filter((s) => !isSolidClass(grid.cellClass[s.cell]!))
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

export function generateMap(
  seed: string | number = "last-exit",
  params: Partial<MapParams> = {},
  library: Library = DEFAULT_LIBRARY,
): GeneratedMap {
  const requested = { ...DEFAULT_PARAMS, ...params };
  // The zone grid is authoritative for extent: the map is exactly the tiles its
  // zones cover, so columns and rows follow rather than being chosen.
  const p: MapParams = {
    ...requested,
    columns: ZONE_COLUMNS * requested.zoneWidth,
    rows: ZONE_ROWS * requested.zoneHeight,
  };
  if (
    !Number.isInteger(p.zoneWidth) ||
    !Number.isInteger(p.zoneHeight) ||
    p.zoneWidth < 1 ||
    p.zoneHeight < 1 ||
    p.zoneWidth > 16 ||
    p.zoneHeight > 8 ||
    p.tileSize !== 6 ||
    !(
      Number.isFinite(p.lootChance) &&
      p.lootChance >= 0 &&
      p.lootChance <= 1
    ) ||
    !Number.isFinite(p.lootTierStep) ||
    p.lootTierStep < 0 ||
    p.lootTierStep > 1 ||
    !Number.isInteger(p.exitCount) ||
    p.exitCount < 1 ||
    p.exitCount > 5 ||
    ![p.contestantRadius, p.hunterRadius].every(
      (x) => Number.isFinite(x) && x > 0,
    )
  )
    throw new Error("invalid map parameters");
  const lv = validateLibrary(library);
  if (!lv.valid) throw new Error(`Invalid library: ${lv.errors.join("; ")}`);
  if (
    library.tiles.some(hasInterior) &&
    Math.max(p.contestantRadius, p.hunterRadius) >= 1
  )
    throw new Error(
      "authored tile interiors keep a 1-cell margin, so agent radii must stay below 1",
    );
  const seedText = String(seed);
  const random = rng(seed),
    zones = makeZones(p),
    { cells, byKey } = makeMask(zones),
    n = cells.length;
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const zoneOf = (slot: MaskCell): MapZone => zoneById.get(slot.zoneId)!;
  const adj: Neighbour[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++)
    for (const [dx, dy, side, opposite] of DIRS) {
      const j = byKey.get(key(cells[i]!.x + dx, cells[i]!.y + dy));
      if (j !== undefined) adj[i]!.push({ j, side, opposite });
    }
  // No topology is solved before selection. Nothing walls a seam, opens one,
  // or decides which seams carry a loop or a squeeze: the map's connectivity is
  // whatever the designs that land next to each other actually declare. What
  // generation still owes is that the result is walkable, and it pays that by
  // choosing designs that stay joined (see `joinedToPlaced`) rather than by
  // cutting geometry to fit a plan.
  const root = Math.min(
    ...cells
      .map((c, i) => [c.x, i])
      .filter((x) => x[0] === 0)
      .map((x) => x[1]),
  );
  // Fill outward from the western edge, so every slot but the first already has
  // a placed neighbour to stay joined to.
  const order: number[] = [root];
  {
    const queued = new Set<number>([root]);
    for (let head = 0; head < order.length; head++)
      for (const e of adj[order[head]!]!)
        if (!queued.has(e.j)) {
          queued.add(e.j);
          order.push(e.j);
        }
    // The mask is one connected shape, so this only guards a future one.
    for (let i = 0; i < n; i++) if (!queued.has(i)) order.push(i);
  }
  const placeAt = new Array<number>(n);
  order.forEach((slot, at) => (placeAt[slot] = at));
  // A seam is settled by whichever of its two tiles is placed first, because
  // the second has to honour what the first claimed. So the only tiles that can
  // ever open a way into slot j are its neighbours placed before it: those are
  // j's speakers, and if every one of them walls j off, j is sealed for good.
  const speakers: number[][] = Array.from({ length: n }, (_, j) =>
    adj[j]!.filter((e) => placeAt[e.j]! < placeAt[j]!).map((e) => e.j),
  );
  const allTiles = library.tiles;
  const adapters = allTiles.filter(isAdapter);
  const authored = allTiles.filter((t) => !isAdapter(t));
  const assigned: Array<Assignment | undefined> = Array(n);
  const taken: Requirements = { segments: new Map(), vertices: new Map() };
  const originOf = (j: number) => ({
    x: cells[j]!.x * p.tileSize,
    y: cells[j]!.y * p.tileSize,
  });
  const contractFor = (j: number) => sideContracts(originOf(j), taken);
  const assignedAt: Array<Assignment | undefined> = [];
  // The hunter is the larger body, so a seam it can use every body can use.
  const walkable = (resolved: ResolvedPrimitives, side: Side) =>
    sideAperture(resolved, side).width >= p.hunterRadius * 2;
  /**
   * Can anything ever get in? A design whose every side facing a neighbouring
   * slot is walled is unreachable wherever it lands, so it is not fill: it is
   * an island. This is the same kind of local check as refusing a design that
   * seals its own interior, not a topology imposed from outside — a slot with
   * no neighbours at all is free to be sealed.
   */
  const enterable =
    (i: number) =>
    (resolved: ResolvedPrimitives): boolean =>
      !adj[i]!.length ||
      adj[i]!.some(
        (e) => sideAperture(resolved, e.side).width >= p.contestantRadius * 2,
      );
  /** Does this candidate stay walkable from the part already placed? */
  const joinsPlaced =
    (i: number) =>
    (resolved: ResolvedPrimitives): boolean =>
      adj[i]!.some(
        (e) => assignedAt[e.j] !== undefined && walkable(resolved, e.side),
      );
  /** Has a placed tile already left a way through into this slot? */
  const opensToward = (from: number, into: number): boolean => {
    const placed = assignedAt[from];
    const e = adj[from]!.find((x) => x.j === into);
    return !!placed && !!e && walkable(placed.resolved, e.side);
  };
  /**
   * Does it avoid sealing a neighbour that has no other way in? A tile may wall
   * a seam freely while some later speaker can still open one; the last speaker
   * for a slot is the one that has to leave a way through.
   */
  const keepsNeighboursOpen =
    (i: number) =>
    (resolved: ResolvedPrimitives): boolean =>
      adj[i]!.every(({ j, side }) => {
        if (assignedAt[j] !== undefined) return true;
        const voices = speakers[j]!;
        if (!voices.includes(i)) return true;
        if (voices.some((v) => v !== i && opensToward(v, j))) return true;
        if (voices.some((v) => v !== i && assignedAt[v] === undefined))
          return true;
        return walkable(resolved, side);
      });
  const layouts: Array<{ id: string; tileIds: string[] }> = [];
  const setMap = new Map<string, TileSet>(
    (library.tileSets || []).map((s) => [s.id, s]),
  );
  const getSetMembers = (id: string): string[] => {
    const s = setMap.get(id);
    if (s) return s.members;
    if (allTiles.some((t) => t.id === id)) return [id];
    return [];
  };
  // Place the most constrained authored layouts first: a small footprint can
  // always find another home, a large one often cannot.
  const orderedLayouts = (library.layouts || [])
    .map((layout, order) => ({ layout, order }))
    .sort(
      (a, b) =>
        b.layout.tiles.length - a.layout.tiles.length || a.order - b.order,
    )
    .map((entry) => entry.layout);
  for (const layout of orderedLayouts) {
    const placements: Array<{
      i: number;
      slots: Array<{ s: LayoutSlot; j: number | undefined }>;
    }> = [];
    for (let i = 0; i < n; i++) {
      const anchor = cells[i]!;
      const slots = layout.tiles.map((s) => ({
        s,
        j: byKey.get(key(anchor.x + s.dx, anchor.y + s.dy)),
      }));
      if (
        slots.every(
          (x) =>
            x.j !== undefined &&
            layout.eligibleTiers.includes(zoneOf(cells[x.j]!).tier) &&
            !assigned[x.j] &&
            selectTemplate(
              allTiles.filter((t) =>
                getSetMembers(x.s.tileSetId).includes(t.id),
              ),
              () => 0,
              p,
              contractFor(x.j!),
              zoneOf(cells[x.j]!),
              [],
              enterable(x.j!),
            ) !== null,
        )
      )
        placements.push({ i, slots });
    }
    if (!placements.length)
      throw new Error(`Authored layout ${layout.id} cannot be placed`);
    const place = placements[Math.floor(random() * placements.length)]!;
    for (const { s, j: slot } of place.slots) {
      const j = slot!;
      const members = new Set(getSetMembers(s.tileSetId));
      const chosen = selectTemplate(
        allTiles.filter((t) => members.has(t.id)),
        random,
        p,
        contractFor(j),
        zoneOf(cells[j]!),
        [],
        enterable(j),
      );
      if (!chosen)
        throw new Error(
          `Authored layout ${layout.id} cannot honor seam at ${cells[j]!.id}`,
        );
      assigned[j] = {
        template: chosen.t,
        templateId: chosen.t.id,
        orientation: chosen.deg,
        anchor: chosen.anchor,
        resolved: chosen.resolved,
        layoutId: layout.id,
      };
      assignedAt[j] = assigned[j];
      claim(
        taken,
        originOf(j),
        chosen.resolved,
        tilePrimitives(chosen.t, chosen.deg),
      );
    }
    layouts.push({
      id: layout.id,
      tileIds: place.slots.map((x) => cells[x.j!]!.id),
    });
  }
  let fallbacks = 0;
  for (const i of order)
    if (!assigned[i]) {
      const contract = contractFor(i);
      const prefer = [keepsNeighboursOpen(i), joinsPlaced(i)];
      const open = enterable(i);
      let chosen = selectTemplate(
        authored,
        random,
        p,
        contract,
        zoneOf(cells[i]!),
        prefer,
        open,
      );
      if (!chosen) {
        chosen = selectTemplate(
          adapters,
          random,
          p,
          contract,
          zoneOf(cells[i]!),
          prefer,
          open,
        );
        if (!chosen) {
          // Say which of the two it is: a library with nothing that fits the
          // seam is a different problem from one whose fill is walled shut.
          const sealed =
            selectTemplate(allTiles, random, p, contract, zoneOf(cells[i]!)) !==
            null;
          throw new Error(
            sealed
              ? `Every design that fits ${cells[i]!.id} is walled on every side that has a neighbour, so nothing could ever reach it. A design whose perimeter is entirely sealed cannot be used as fill.`
              : `No compatible template for ${cells[i]!.id}; library has no generic fallback`,
          );
        }
        fallbacks++;
      }
      assigned[i] = {
        template: chosen.t,
        templateId: chosen.t.id,
        orientation: chosen.deg,
        anchor: chosen.anchor,
        resolved: chosen.resolved,
      };
      assignedAt[i] = assigned[i];
      claim(
        taken,
        originOf(i),
        chosen.resolved,
        tilePrimitives(chosen.t, chosen.deg),
      );
    }
  const tiles: PlacedTile[] = cells.map((c, i) => {
    const tile: PlacedTile = {
      ...c,
      x: c.x * p.tileSize,
      y: c.y * p.tileSize,
      templateId: assigned[i]!.templateId,
      orientation: assigned[i]!.orientation,
      anchor: {
        x: c.x * p.tileSize + assigned[i]!.anchor.x,
        y: c.y * p.tileSize + assigned[i]!.anchor.y,
      },
    };
    // Absent rather than undefined, so a decoded map is deep-equal to this one.
    if (assigned[i]!.layoutId !== undefined)
      tile.layoutId = assigned[i]!.layoutId;
    return tile;
  });

  const placements: MacroPlacement[] = tiles.map((tile) => {
    const design = allTiles.find((t) => t.id === tile.templateId)!;
    return {
      id: tile.id,
      structure: compileTileDesign(design, tile.orientation),
      origin: {
        x: Math.floor(tile.x / p.tileSize) * p.tileSize,
        y: Math.floor(tile.y / p.tileSize) * p.tileSize,
      },
      orientation: 0,
    } as MacroPlacement;
  });

  const cellMask: Point[] = [];
  for (const c of cells) {
    for (let dy = 0; dy < p.tileSize; dy++) {
      for (let dx = 0; dx < p.tileSize; dx++) {
        cellMask.push({ x: c.x * p.tileSize + dx, y: c.y * p.tileSize + dy });
      }
    }
  }

  const composition = composeMacro({
    version: 1,
    seed: seedText,
    width: p.columns * p.tileSize,
    height: p.rows * p.tileSize,
    mask: cellMask,
    defaultCellClass: "grass",
    placements,
  });

  let regions = composition.regions;
  const grid = {
    W: composition.width,
    H: composition.height,
    cellClass: composition.cellClass,
    segmentOpen: composition.segmentOpen,
    cellLevel: new Array(composition.width * composition.height).fill(0),
    vertices: new Map(),
    // The same addressing `macro.ts` composed with, and the addressing micro
    // generation states segments through. It was a stub while nothing wrote to
    // the grid after composition; something does now.
    segmentIndex: (vertical: boolean, line: number, offset: number) =>
      vertical
        ? offset * (composition.width + 1) + line
        : (composition.width + 1) * composition.height +
          line * composition.width +
          offset,
  };

  const left = cells.map((c, i) => ({ c, i })).filter((x) => x.c.x === 0),
    right = cells
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.x >= Math.max(0, p.columns - 5));
  const spawn = left[Math.floor(left.length / 2)]!.i,
    hunter = right.reduce(
      (best, x) => (x.c.x > cells[best]!.x ? x.i : best),
      right[0]!.i,
    );
  const exitChoices = right.sort((a, b) => b.c.x - a.c.x || a.c.y - b.c.y);
  const exits = exitChoices.slice(0, p.exitCount);
  if (exits.length < p.exitCount)
    throw new Error("diamond does not contain enough distinct exit tiles");
  const at = (i: number): Point => ({
    x: tiles[i]!.anchor.x,
    y: tiles[i]!.anchor.y,
  });
  const feats: MapFeature[] = [
    { id: "spawn", kind: "spawn", tileId: tiles[spawn]!.id, ...at(spawn) },
    {
      id: "hunter-spawn",
      kind: "hunter-spawn",
      tileId: tiles[hunter]!.id,
      ...at(hunter),
    },
    ...exits.map((e, i) => ({
      id: `exit-${i}`,
      kind: "exit" as const,
      tileId: tiles[e.i]!.id,
      ...at(e.i),
    })),
  ];
  const mid = cells.filter(
      (c) => c.x > p.columns * 0.25 && c.x < p.columns * 0.8,
    ),
    markers = mid.slice();
  if (markers.length < 3)
    throw new Error("Map is too small for two transit stations and a charger");
  for (const [id, kind] of [
    ["warp-a", "warp"],
    ["warp-b", "warp"],
    ["charger", "charger"],
  ] as Array<[string, MapFeature["kind"]]>) {
    const c = markers.splice(Math.floor(random() * markers.length), 1)[0]!,
      index = tiles.findIndex((t) => t.id === c.id);
    feats.push({ id, kind, tileId: tiles[index]!.id, ...at(index) });
  }
  for (const placement of layouts) {
    const index = tiles.findIndex((t) => t.id === placement.tileIds[0]);
    feats.push({
      id: `set-piece-${placement.id}`,
      kind: "set-piece",
      tileId: tiles[index]!.id,
      ...at(index),
      layoutId: placement.id,
      tileIds: placement.tileIds,
    });
  }
  const reservedTiles = new Set(feats.map((f) => f.tileId));
  const tileIdAt = new Map(tiles.map((t, i) => [key(t.x, t.y), i]));
  const tileOfCell = (x: number, y: number) =>
    tileIdAt.get(
      key(
        Math.floor(x / p.tileSize) * p.tileSize,
        Math.floor(y / p.tileSize) * p.tileSize,
      ),
    );
  // Micro generation: one pass per discovered region, never per tile.
  const regionOf = new Int32Array(grid.W * grid.H).fill(-1);
  regions.forEach((region, index) => {
    for (const cell of region.cells) regionOf[cell] = index;
  });
  // Decide the street network before any builder runs, out of the composed
  // geometry. Everything it covers is reserved; the rest is buildable.
  const streets = planStreets(tiles, adj, grid, p, spawn, seedText);
  const micro = generateMicro(
    regions,
    grid,
    library,
    zones,
    p,
    regionOf,
    streets.corridors,
    (x, y) => streets.standing[y * grid.W + x] === 1,
    (x, y) => {
      if (streets.reserved[y * grid.W + x]) return true;
      const t = tileOfCell(x, y);
      return t === undefined || reservedTiles.has(tiles[t]!.id);
    },
  );
  const repair = reconnectAnchors(
    tiles,
    grid,
    p,
    tiles[spawn]!.anchor,
    micro.obstacles,
  );
  micro.obstacles = repair.obstacles;
  const spawns = micro.spawns;
  // The artifact carries the partition of the composed result, not the one the
  // builders were handed. A builder that stated a wall genuinely split its area
  // in two, and a region whose class disagrees with its own cells is not a
  // region at all; searching again is how both stay true by construction.
  regions = searchRegions(grid, seedText);
  const regionAt = new Int32Array(grid.W * grid.H).fill(-1);
  regions.forEach((region, index) => {
    for (const cell of region.cells) regionAt[cell] = index;
  });
  // A prop stays inside one cell by contract, so its midpoint names the region
  // that now owns it -- which may not be the one whose builder placed it.
  for (const wall of micro.obstacles) {
    const cx = Math.floor((wall.x1 + wall.x2) / 2),
      cy = Math.floor((wall.y1 + wall.y2) / 2);
    if (cx < 0 || cy < 0 || cx >= grid.W || cy >= grid.H) continue;
    regions[regionAt[cy * grid.W + cx]!]?.obstacles.push(wall);
  }
  const spawnCells = new Set(spawns.map((slot) => slot.cell));
  for (const region of regions) {
    const generator = micro.ownerOf[region.cells[0]!] ?? "";
    region.manifest = {
      ...(generator ? { generator } : {}),
      spawnsPlaced: region.cells.filter((cell) => spawnCells.has(cell)).length,
      obstaclesPlaced: region.obstacles.length,
      corridorsHonored: region.cells.every((cell) => micro.honored[cell] === 1),
    };
  }
  // A builder may site a feature of its own: where a physical exit or a charger
  // stands is a micro detail, per docs/DESIGN_DECISIONS.md.
  micro.features.forEach((feature, index) => {
    const owner = tileOfCell(feature.x, feature.y);
    const cell = feature.y * grid.W + feature.x;
    if (owner === undefined || isSolidClass(grid.cellClass[cell]!)) return;
    feats.push({
      id: `micro-${feature.kind}-${index}`,
      kind: feature.kind as MapFeature["kind"],
      tileId: tiles[owner]!.id,
      x: feature.x + 0.5,
      y: feature.y + 0.5,
    });
  });

  let adjacentPairs = 0;
  for (let i = 0; i < n; i++)
    for (const e of adj[i]!) if (i < e.j) adjacentPairs++;
  const map: GeneratedMap = {
    version: 1,
    seed: seedText,
    params: p,
    width: p.columns * 6,
    height: p.rows * 6,
    zones,
    tiles,
    // Both are filled in below. Geometry follows from the primitives, and the
    // seams between tiles follow from the geometry, so neither is assembled
    // beside the map: they are read back out of what the tiles laid down.
    edges: [],
    walls: [],
    features: feats,
    grid: {
      width: grid.W,
      height: grid.H,
      cells: {
        class: encodeGrid(grid.cellClass),
        // Flat maps say nothing about height, so the grid is simply absent.
        ...(grid.cellLevel.some((level) => level !== 0)
          ? { level: encodeGrid(grid.cellLevel) }
          : {}),
        spawns,
      },
      segments: { open: encodeGrid(grid.segmentOpen) },
      vertices: [...grid.vertices]
        .sort((a, b) => a[0] - b[0])
        .map(([vertex, meta]) => ({
          vertex,
          ...(meta.class === ANY_CLASS ? {} : { class: meta.class }),
          ...(meta.height === "any" ? {} : { height: meta.height }),
        })),
    },
    regions,
    metrics: {
      tileCount: n,
      // Both are filled in below, once the seams have been measured. The
      // dead-end count is still a tile-graph leaf count and not a geometric
      // cul-de-sac (NEXT_TASKS item 2); a squeeze is a seam a contestant can
      // use and a hunter cannot, which is a fact about the geometry rather
      // than a label anyone assigned.
      deadEnds: 0,
      squeezes: 0,
      contestantDistance: 0,
      hunterDistance: 0,
      detourRatio: 0,
      regionCount: regions.length,
      templateFallbacks: fallbacks,
      lootCount: spawns.length,
      obstacleCount: regions.reduce((n, r) => n + r.obstacles.length, 0),
      interiorWalls: 0,
      cellCount: n * p.tileSize * p.tileSize,
      solidFraction:
        grid.cellClass.filter((c) => c === SOLID_CLASS).length /
        Math.max(1, n * p.tileSize * p.tileSize),
      explicitVertices: grid.vertices.size,
      // Tile anchors micro generation stranded, and the props given back to
      // reach them again. Both should stay small; a large figure means a
      // builder is fighting the street network rather than using it.
      strandedAnchors: repair.stranded,
      propsReclaimed: repair.dropped,
      // Counted rather than inferred from the wall total: two builders once
      // produced nothing at all for a whole checkpoint, and the aggregate wall
      // count was inside its own baseline noise the entire time.
      microBlocks: micro.declared.blocks,
      microCells: micro.declared.cells,
      microSegments: micro.declared.segments,
      largestRegion: regions.reduce(
        (best, r) => Math.max(best, r.cells.length),
        0,
      ),
    },
    validation: { valid: false, errors: [] },
  };
  map.walls = deriveWalls(map);
  map.edges = deriveEdges(map);
  map.metrics.interiorWalls = map.walls.filter(
    (w) =>
      (w.x1 === w.x2 && w.x1 % p.tileSize !== 0) ||
      (w.y1 === w.y2 && w.y1 % p.tileSize !== 0),
  ).length;
  {
    const degree = new Map<string, number>(tiles.map((t) => [t.id, 0]));
    for (const e of map.edges) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
    }
    const contestant = navGraph(map, "contestant"),
      hunter = navGraph(map, "hunter");
    map.metrics.deadEnds = [...degree.values()].filter((d) => d === 1).length;
    map.metrics.squeezes = map.edges.filter(
      (e) =>
        contestant.get(e.a)?.includes(e.b) && !hunter.get(e.a)?.includes(e.b),
    ).length;
    map.metrics.sealedSeams = adjacentPairs - map.edges.length;
  }
  const exitId = exits[0]!.i;
  const cp = findPath(map, tiles[spawn]!.id, tiles[exitId]!.id, "contestant"),
    hp = findPath(map, tiles[spawn]!.id, tiles[exitId]!.id, "hunter");
  map.metrics.contestantDistance = Math.max(0, cp.length - 1) * 6;
  map.metrics.hunterDistance = hp.length
    ? Math.max(0, hp.length - 1) * 6
    : Infinity;
  map.metrics.detourRatio =
    map.metrics.contestantDistance /
    Math.max(1, Math.abs(tiles[exitId]!.x - tiles[spawn]!.x));
  const exitDistances = exits.map(
    (e) =>
      (findPath(map, tiles[spawn]!.id, tiles[e.i]!.id, "contestant").length -
        1) *
      6,
  );
  map.metrics.exitCostSpread =
    Math.max(...exitDistances) / Math.max(1, Math.min(...exitDistances));
  map.metrics.hunterToContestantRatio =
    map.metrics.hunterDistance / Math.max(1, map.metrics.contestantDistance);
  // eslint-disable-next-line no-self-assign
  map.metrics.adapterFraction = fallbacks / tiles.length;
  map.validation = validateMap(map);
  return map;
}

/** Cached readers over a map's coded grids, so callers never decode by hand. */
interface GridViews {
  width: number;
  height: number;
  verticalCount: number;
  cellClass: (index: number) => string;
  /** True where the class is the reserved material class. */
  cellSolid: (index: number) => boolean;
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
  const views: GridViews = {
    width: grid.width,
    height: grid.height,
    verticalCount: (grid.width + 1) * grid.height,
    cellClass: readClass,
    cellSolid: (index) => isSolidClass(readClass(index)),
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
export function segmentOpenAt(map: GeneratedMap, index: number): Span {
  return gridViews(map).segmentOpen(index);
}
export function vertexIndexAt(map: GeneratedMap, x: number, y: number): number {
  return y * (map.grid.width + 1) + x;
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
    blocked: views.cellSolid(index),
    height: views.cellLevel(index),
    spawn: kind === undefined ? null : { kind },
  };
}
/** The tier zone covering a cell, or null when the cell lies outside the map. */
export function cellZone(map: GeneratedMap, index: number): MapZone | null {
  const views = gridViews(map);
  const x = index % views.width,
    y = Math.floor(index / views.width);
  return (
    map.zones.find(
      (z) =>
        x >= z.cells[0] &&
        y >= z.cells[1] &&
        x <= z.cells[2] &&
        y <= z.cells[3],
    ) ?? null
  );
}
/** The zone a placed tile belongs to. */
export function tileZone(map: GeneratedMap, tile: MaskCell): MapZone | null {
  return map.zones.find((z) => z.id === tile.zoneId) ?? null;
}

/**
 * Every wall a map has: the closed part of each segment that touches a laid-out
 * cell, merged into runs, plus whatever micro generation placed. Geometry is
 * never stored — it follows from the primitives, so one implementation serves
 * both generation and reading an artifact back.
 */
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
  for (const region of map.regions) walls.push(...region.obstacles);
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

export function validateMap(input: unknown): ValidationResult {
  const map = input as GeneratedMap;
  const errors: string[] = [];
  tileCaches.delete(map);
  navCaches.delete(map);
  reachCaches.delete(map);
  viewCaches.delete(map);
  if (map && typeof map === "object") clearNavCache(map);
  if (!map || map.version !== 1) errors.push("map.version must be 1");
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
    else if (views.cellSolid(spawn.cell))
      errors.push("region placed a spawn in a solid cell");
  }
  const claimed = new Set<number>();
  for (const r of map.regions) {
    if (!r || !Array.isArray(r.cells) || !r.manifest) {
      errors.push("malformed region");
      continue;
    }
    for (const i of r.cells)
      if (!Number.isInteger(i) || i < 0 || i >= cellCount || claimed.has(i))
        errors.push("invalid region cell");
      else claimed.add(i);
    const actual = r.cells.filter((i) => views.spawns.has(i)).length;
    if (actual !== r.manifest.spawnsPlaced)
      errors.push("region spawn manifest disagrees with cells");
    if (!Array.isArray(r.obstacles))
      errors.push("region obstacles must be a list");
    else {
      if (r.obstacles.length !== r.manifest.obstaclesPlaced)
        errors.push("region obstacle manifest disagrees with its geometry");
      const own = new Set(r.cells);
      for (const o of r.obstacles) {
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
