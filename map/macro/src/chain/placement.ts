/**
 * Placement (51 stage 1): seed, params and library to a Layout. Set piece classes place
 * their quotas by today's rules, lifted out of `placeLayout`. WFC fills the remaining
 * slots over adjacency compatibility, so no tile is placed that breaks a prescription.
 * A sample whose set pieces don't fit, or whose fill has no solution, is retried, each
 * attempt on its own stream.
 */
import { layoutSlots, libraryFingerprint, makeZones, ZONE_COLUMNS, ZONE_ROWS } from "../core.ts";
import type { MaskCell, MapZone } from "../types.ts";
import { solveWfc } from "../wfc.ts";
import type { TileOption, WfcCompatibility, WfcGrid } from "../wfc.ts";
import { orientedDesigns } from "./declared-grid.ts";
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE } from "./library.ts";
import type { ChainLibrary, ChainSetPiece, ChainSetPieceClass, ChainTileDesign, PlacementRule } from "./library.ts";
import { stream } from "./random.ts";
import type { Stream } from "./random.ts";
import type { ChainParams, Layout, MacroStages, Orientation, PlacedSlot, SegmentKey, SetPieceInstance } from "./types.ts";

export const PLACEMENT_ATTEMPTS = 50;
/** Game mode's zone size (52, "Tier zones and the mask"). Playground mode allows others. */
export const GAME_ZONE = { width: 12, height: 6 } as const;

/** The order classes are drawn in: today's order, with `charger` after it. */
const RULE_ORDER: readonly PlacementRule[] = ["start", "end", "enormous", "medium", "small", "charger"];

/** Where an instance's anchor slot may go, in tile units, given the piece's extent. */
type Filter = (anchor: MaskCell, width: number) => boolean;

/** Today's placement rules (52), over a map `columns` by `rows` tiles. */
function ruleFilter(rule: PlacementRule, nth: number, columns: number, rows: number): Filter {
  switch (rule) {
    case "start": return (c) => c.x === 0;
    case "end": return (c, w) => c.x + w >= columns;
    case "enormous": {
      // The middle band, one instance per vertical third.
      const third = nth % 3;
      return (c, w) => c.x > columns / 4 && c.x + w < columns * 3 / 4 &&
        c.y >= rows * third / 3 && c.y < rows * (third + 1) / 3;
    }
    case "medium": return (c, w) => c.x < columns / 3 || c.x + w > columns * 2 / 3;
    case "small":
    case "charger": return () => true;
  }
}

interface Pick { setPieceClass: ChainSetPieceClass; piece: ChainSetPiece; filter: Filter }

/** Every class's quota of set pieces, in placement order: largest first, ties as drawn. */
function pickSetPieces(library: ChainLibrary, pieces: Map<string, ChainSetPiece>, columns: number, rows: number, random: Stream): Pick[] {
  const picks: Pick[] = [];
  for (const rule of RULE_ORDER) for (const setPieceClass of library.setPieceClasses) {
    if (setPieceClass.placementRule !== rule) continue;
    const members = setPieceClass.setPieces.map((id) => pieces.get(id)!);
    // Enormous pieces are distinct; every other class draws with replacement.
    const chosen = rule === "enormous"
      ? random.shuffle(members).slice(0, setPieceClass.quota)
      : Array.from({ length: setPieceClass.quota }, () => random.pick(members));
    chosen.forEach((piece, nth) => picks.push({ setPieceClass, piece, filter: ruleFilter(rule, nth, columns, rows) }));
  }
  return picks.sort((a, b) => b.piece.tiles.length - a.piece.tiles.length);
}

/** A design's own eligibility (52), wherever it is placed: by the fill or in a set piece slot. */
const eligibleIn = (tile: ChainTileDesign, zone: MapZone): boolean =>
  (!tile.eligibleTiers || tile.eligibleTiers.includes(zone.tier)) &&
  (!tile.eligibleBonus || tile.eligibleBonus.includes(zone.bonus));

/** Adjacency prescriptions a design states, which WFC prefers to place early. */
function difficulty(design: ChainTileDesign): number {
  return Object.values(design.segments ?? {}).filter((s) => s.adjacency !== undefined && s.adjacency !== "any").length;
}

/** A cell meets a prescription when it is the class required, or `any`. */
const meets = (required: string | undefined, found: string): boolean =>
  required === undefined || required === "any" || found === required || found === "any";

const S = CHAIN_TILE_SIZE;
/** `b` east of `a`: each side's prescriptions on the shared seam against the other's cells. */
function fitsEast(a: OrientedDesign, b: OrientedDesign): boolean {
  for (let i = 0; i < S; i++) {
    if (!meets(a.segments.get(`v:${S},${i}`)?.adjacency, b.cells[i * S]!)) return false;
    if (!meets(b.segments.get(`v:0,${i}`)?.adjacency, a.cells[i * S + S - 1]!)) return false;
  }
  return true;
}
/** `b` south of `a`. */
function fitsSouth(a: OrientedDesign, b: OrientedDesign): boolean {
  for (let i = 0; i < S; i++) {
    if (!meets(a.segments.get(`h:${i},${S}`)?.adjacency, b.cells[i]!)) return false;
    if (!meets(b.segments.get(`h:${i},0`)?.adjacency, a.cells[(S - 1) * S + i]!)) return false;
  }
  return true;
}

/**
 * A corner cell of a middle tile is the target of two neighbours' seams: the two
 * orthogonal neighbours beside that corner, which are diagonal to each other. Per
 * corner, the seam key each neighbour aims at it, by the neighbour's side of the middle.
 */
const CORNERS = {
  NW: { W: `v:${S},0`, N: `h:0,${S}` },
  NE: { N: `h:${S - 1},${S}`, E: "v:0,0" },
  SE: { E: `v:0,${S - 1}`, S: `h:${S - 1},0` },
  SW: { S: "h:0,0", W: `v:${S},${S - 1}` },
} as const satisfies Record<string, Partial<Record<"N" | "E" | "S" | "W", SegmentKey>>>;
type Corner = keyof typeof CORNERS;
const STEP = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const;

/** Two prescriptions aimed at one cell agree unless both state different classes. */
const agree = (a: string | undefined, b: string | undefined): boolean =>
  a === undefined || b === undefined || a === "any" || b === "any" || a === b;

/**
 * Adjacency compatibility (51 stage 1), as WFC relations.
 * - `N`, `E`, `S`, `W`: a neighbour's cell must match each adjacency prescription across
 *   the seam, or be `any`.
 * - `NW:W` and the like: the two neighbours beside one corner of a middle tile mustn't
 *   ask its corner cell for two classes. Where that cell is `any`, this is the only rule
 *   that keeps it to one; where it isn't, the seams already require both to match it.
 *
 * Passability can't conflict, so it never constrains the solve.
 */
export function adjacencyCompatibility(library: ChainLibrary): WfcCompatibility {
  const oriented = orientedDesigns(library);
  const of = (option: TileOption) => oriented(option.templateId, option.orientation);
  return (a, relation, b) => {
    switch (relation) {
      case "E": return fitsEast(of(a), of(b));
      case "W": return fitsEast(of(b), of(a));
      case "S": return fitsSouth(of(a), of(b));
      case "N": return fitsSouth(of(b), of(a));
    }
    const [corner, side] = relation.split(":") as [Corner, string];
    const keys = CORNERS[corner] as Record<string, SegmentKey>;
    const other = Object.keys(keys).find((s) => s !== side)!;
    return agree(of(a).segments.get(keys[side]!)?.adjacency, of(b).segments.get(keys[other]!)?.adjacency);
  };
}

/**
 * Links each slot to its four neighbours across seams, and, for every slot standing
 * between two of its neighbours, those two by that slot's corner. A corner whose
 * middle slot is outside the map has no cell to ask for, so it links nothing.
 */
export function adjacencyLinks(grid: WfcGrid): void {
  const at = new Map<string, number>();
  grid.forEach((c, i) => at.set(`${c.x},${c.y}`, i));
  const beside = (c: { x: number; y: number }, side: keyof typeof STEP) => at.get(`${c.x + STEP[side][0]},${c.y + STEP[side][1]}`);
  for (const c of grid) {
    c.links = [];
    for (const side of ["N", "S", "E", "W"] as const) {
      const cell = beside(c, side);
      if (cell !== undefined) c.links.push({ cell, relation: side });
    }
  }
  for (const middle of grid) for (const [corner, keys] of Object.entries(CORNERS)) {
    const [one, two] = Object.keys(keys) as Array<keyof typeof STEP>;
    const a = beside(middle, one!), b = beside(middle, two!);
    if (a === undefined || b === undefined) continue;
    grid[a]!.links.push({ cell: b, relation: `${corner}:${one}` });
    grid[b]!.links.push({ cell: a, relation: `${corner}:${two}` });
  }
}

type Failure = `set piece ${string}` | "wfc";

/** One sample: set pieces, then WFC. A failure names what failed, for the final error. */
function sample(
  seed: string, params: ChainParams, library: ChainLibrary, fingerprint: string,
  mask: MaskCell[], zones: Map<string, MapZone>, fill: (zone: MapZone) => ChainTileDesign[],
  random: Stream,
): Layout | Failure {
  const columns = ZONE_COLUMNS * params.zoneWidth, rows = ZONE_ROWS * params.zoneHeight;
  const designs = new Map(library.tiles.map((tile) => [tile.id, tile]));
  const tileSets = new Map(library.tileSets.map((set) => [set.id, set]));
  const pieces = new Map(library.setPieces.map((piece) => [piece.id, piece]));
  const slotAt = new Map(mask.map((cell, i) => [`${cell.x},${cell.y}`, i]));
  const assigned: Array<{ design: string; orientation: Orientation } | undefined> = new Array(mask.length);
  const instances: SetPieceInstance[] = [];

  const picks = (params.mode ?? "game") === "game" ? pickSetPieces(library, pieces, columns, rows, random) : [];
  for (const [nth, { setPieceClass, piece, filter }] of picks.entries()) {
    const width = Math.max(...piece.tiles.map((s) => s.dx)) + 1;
    // The members of each slot's tile set eligible in that slot's zone, and allowing the
    // slot's orientation where it fixes one.
    const eligible = (k: number, j: number): ChainTileDesign[] => {
      const zone = zones.get(mask[j]!.zoneId)!, { tileSetId, orientation } = piece.tiles[k]!;
      return tileSets.get(tileSetId)!.members.map((id) => designs.get(id)!).filter((tile) =>
        eligibleIn(tile, zone) && (orientation === undefined || tile.orientations.includes(orientation)));
    };
    const placements: number[][] = [];
    for (const anchor of mask) {
      if (!filter(anchor, width)) continue;
      const covered = piece.tiles.map((s) => slotAt.get(`${anchor.x + s.dx},${anchor.y + s.dy}`));
      if (covered.every((j, k) => j !== undefined && !assigned[j] &&
        (!piece.eligibleTiers || piece.eligibleTiers.includes(zones.get(mask[j]!.zoneId)!.tier)) &&
        eligible(k, j).length > 0))
        placements.push(covered as number[]);
    }
    if (!placements.length) return `set piece ${piece.id}`;
    const covered = random.pick(placements);
    piece.tiles.forEach((s, k) => {
      const design = random.pick(eligible(k, covered[k]!));
      const orientation = (s.orientation ?? random.pick(design.orientations)) as Orientation;
      assigned[covered[k]!] = { design: design.id, orientation };
    });
    instances.push({
      id: `${piece.id}#${nth}`, setPiece: piece.id, setPieceClass: setPieceClass.id,
      slots: covered.map((j) => ({ col: mask[j]!.col, row: mask[j]!.row })),
    });
  }

  // Each attempt gets fresh options: the solver numbers them on first use.
  const options = new Map<string, TileOption[]>();
  const optionsFor = (zone: MapZone): TileOption[] => {
    let list = options.get(zone.id);
    if (!list) options.set(zone.id, list = fill(zone).flatMap((design) => design.orientations.map((orientation) => ({
      templateId: design.id, orientation: orientation as Orientation, difficulty: difficulty(design), weight: design.weight ?? 1,
    }))));
    return list;
  };
  const grid: WfcGrid = mask.map((cell, i) => {
    const fixed = assigned[i];
    return {
      x: cell.x, y: cell.y,
      domain: fixed
        ? [{ templateId: fixed.design, orientation: fixed.orientation, difficulty: 0, weight: 1 }]
        : optionsFor(zones.get(cell.zoneId)!),
      links: [],
    };
  });
  adjacencyLinks(grid);
  const solved = solveWfc(grid, columns, rows, adjacencyCompatibility(library), () => random.next());
  if (!solved) return "wfc";

  const slots: PlacedSlot[] = mask
    .map((cell, i) => ({ col: cell.col, row: cell.row, design: solved[i]!.domain[0]!.templateId, orientation: solved[i]!.domain[0]!.orientation }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  return { seed, params: { ...params }, library: fingerprint, slots, setPieces: instances };
}

export const placement: MacroStages["placement"] = (seed, params, library) => {
  const mode = params.mode ?? "game";
  if (mode === "game" && (params.zoneWidth !== GAME_ZONE.width || params.zoneHeight !== GAME_ZONE.height))
    throw new Error(`game mode requires ${GAME_ZONE.width} x ${GAME_ZONE.height} tile zones; choose playground mode for others`);
  const zoneParams = { ...params, tileSize: CHAIN_TILE_SIZE };
  const zones = new Map(makeZones(zoneParams).map((zone) => [zone.id, zone]));
  const mask = layoutSlots(zoneParams);

  // A feature class is painted only inside its owning set pieces (51, "Features"), so
  // the fill never places a design that paints one.
  const featureClasses = new Set(Object.entries(library.cellClasses)
    .filter(([, cellClass]) => Object.keys(cellClass.features ?? {}).length).map(([id]) => id));
  const paintsFeature = (tile: ChainTileDesign): boolean =>
    featureClasses.has(tile.defaultCellClass) || Object.values(tile.legend ?? {}).some((id) => featureClasses.has(id));

  // Problems no retry can fix are reported once, not fifty times.
  const fillByZone = new Map<string, ChainTileDesign[]>();
  for (const zone of zones.values()) {
    const eligible = library.tiles.filter((tile) => !paintsFeature(tile) && eligibleIn(tile, zone));
    if (!eligible.length) throw new Error(`no tile design is eligible for zone ${zone.id} (tier ${zone.tier}, bonus ${zone.bonus})`);
    fillByZone.set(zone.id, eligible);
  }
  if (mode === "game") for (const setPieceClass of library.setPieceClasses)
    if (setPieceClass.placementRule === "enormous" && setPieceClass.setPieces.length < setPieceClass.quota)
      throw new Error(`set piece class ${setPieceClass.id} needs ${setPieceClass.quota} distinct set pieces and has ${setPieceClass.setPieces.length}`);

  const fingerprint = libraryFingerprint(library);
  const failures = new Map<Failure, number>();
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const result = sample(seed, params, library, fingerprint, mask, zones, (zone) => fillByZone.get(zone.id)!,
      stream(seed, "placement", attempt));
    if (typeof result !== "string") return result;
    failures.set(result, (failures.get(result) ?? 0) + 1);
  }
  const detail = [...failures].map(([failure, count]) => `${failure} (${count}/${PLACEMENT_ATTEMPTS})`).join(", ");
  throw new Error(`placement found no valid layout for seed ${seed}: ${detail}`);
};
