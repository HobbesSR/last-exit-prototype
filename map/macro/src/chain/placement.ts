/**
 * Placement (51 stage 1): seed, params and library to a Layout. Set piece classes place
 * their quotas by today's rules, lifted out of `placeLayout`. WFC fills the remaining
 * slots over adjacency compatibility, so no tile is placed that breaks a prescription,
 * and under the open-face rule, so no layout fails the proof's gate or the portal rule.
 * A sample whose set pieces don't fit, or whose fill has no solution, is retried, each
 * attempt on its own stream.
 */
import type { PlacementTraceDetail, PlacementTraceEvent } from "./placement-trace.ts";
import { libraryFingerprint } from "../coding.ts";
import { solveWfc, wfcIterationCap } from "../wfc.ts";
import type { TileOption, WfcCompatibility, WfcGrid } from "../wfc.ts";
import { orientedDesigns } from "./declared-grid.ts";
import { openFaceRule } from "./open-face.ts";
import type { OrientedDesign } from "./declared-grid.ts";
import { CHAIN_TILE_SIZE, countParamsProblem } from "./library.ts";
import type { ChainLibrary, ChainSetPiece, ChainSetPieceClass, ChainTileDesign, PlacementRule } from "./library.ts";
import { passabilityFits } from "./resolution.ts";
import { stream } from "./random.ts";
import type { Stream } from "./random.ts";
import type { ChainParams, Layout, MacroStages, Orientation, PlacedSlot, SegmentKey, SetPieceInstance } from "./types.ts";
import { planTiles, zonePlan } from "./zone-plan.ts";
import type { PlacementFilter, ZonePlan } from "./zone-plan.ts";
import { layoutSlots, makeZones } from "./zones.ts";
import type { MapZone, MaskCell } from "./zones.ts";

export const PLACEMENT_ATTEMPTS = 50;
/**
 * Open-face refusals an attempt may make since it last reached a new depth before it gives up
 * and the next attempt starts on its own stream (#849, 42.37). Under the matched libraries some
 * attempts churn among their last few slots until the iteration cap, an hour at 36 x 18; this
 * ends them in seconds. It changes no rule: a layout is valid or not as before, and only an
 * attempt that stalls this long is abandoned. Chosen from 12 x 6 to 36 x 18 seed batches.
 */
export const PLACEMENT_STALL_LIMIT = 500;
/**
 * A game map's params, as the chain's tests have used them, with the old generator's
 * exits. S5 scaled the old loot gradient by 0.37 for bigger set pieces (#170);
 * #214 reduces it by about another fifth for the more varied fill (14, 52).
 * The tools start from these, and each can be overridden.
 */
const { defaultZone } = zonePlan();
export const DEFAULT_CHAIN_PARAMS: Readonly<ChainParams> = Object.freeze({
  mode: "game", zoneWidth: defaultZone.width, zoneHeight: defaultZone.height,
  exitCount: 2, contestantCount: 8, hunterCount: 3, lootChance: 0.012, lootTierStep: 0.027,
});

/** Keep the old order, giving distributed transit space before the flexible fill pieces. */
const RULE_ORDER: readonly PlacementRule[] = ["start", "end", "enormous", "transit", "medium", "small", "charger"];

interface Pick { setPieceClass: ChainSetPieceClass; piece: ChainSetPiece; filter: PlacementFilter }

/** Every class's quota of set pieces, in placement order: largest first, ties as drawn. */
function pickSetPieces(library: ChainLibrary, pieces: Map<string, ChainSetPiece>, plan: ZonePlan, columns: number, rows: number, random: Stream): Pick[] {
  const picks: Pick[] = [];
  for (const rule of RULE_ORDER) for (const setPieceClass of library.setPieceClasses) {
    if (setPieceClass.placementRule !== rule) continue;
    const members = setPieceClass.setPieces.map((id) => pieces.get(id)!);
    // Enormous pieces are distinct; every other class draws with replacement.
    const chosen = rule === "enormous"
      ? random.shuffle(members).slice(0, setPieceClass.quota)
      : Array.from({ length: setPieceClass.quota }, () => random.pick(members));
    chosen.forEach((piece, nth) => picks.push({ setPieceClass, piece, filter: plan.placementFilter(rule, nth, setPieceClass.quota, columns, rows) }));
  }
  return picks.sort((a, b) => b.piece.tiles.length - a.piece.tiles.length);
}

/** Whether the fill may place a design: not stated `fillable: false`, nor weighted 0 as older content says it (52). */
const fillable = (tile: ChainTileDesign): boolean => tile.fillable !== false && tile.weight !== 0;

/**
 * One orientation's fill weight. Under `matched` rules a design's weight is its total, shared
 * evenly by the orientations it allows, so a rotatable tile is drawn as often as a fixed one
 * (Corey, 2026-11-06, 17.2.2: "the least surprising and most uniform way"). Otherwise each
 * orientation carries the whole weight, as before.
 */
const optionWeight = (design: ChainTileDesign, library: ChainLibrary): number =>
  (design.weight ?? 1) / (library.passabilityRules === "matched" ? design.orientations.length : 1);

/** A design's own eligibility (52), wherever it is placed: by the fill or in a set piece slot. */
const eligibleIn = (tile: ChainTileDesign, zone: MapZone): boolean =>
  (!tile.eligibleTiers || tile.eligibleTiers.includes(zone.tier)) &&
  (!tile.eligibleBonus || tile.eligibleBonus.includes(zone.bonus));

/**
 * How hard a design is to fit, which WFC prefers to place early: the adjacency prescriptions it
 * states, and under `matched` passability (17.2.2) also each perimeter segment stating
 * `passable` or a hint, since only those constrain a neighbour; `any` fits anything.
 */
function difficulty(design: ChainTileDesign, matched = false): number {
  let count = 0;
  for (const [key, s] of Object.entries(design.segments ?? {})) {
    if (s.adjacency !== undefined && s.adjacency !== "any") count++;
    // The library writes `h:line,offset`; a perimeter segment lies on line 0 or 6.
    const line = Number(key.slice(2).split(",")[0]);
    if (matched && (line === 0 || line === S) && s.passability !== undefined && s.passability !== "any") count++;
  }
  return count;
}

/** A cell meets a prescription when it is the class required, or `any`. */
const meets = (required: string | undefined, found: string): boolean =>
  required === undefined || required === "any" || found === required || found === "any";

const S = CHAIN_TILE_SIZE;
/** `b` east of `a`: each side's prescriptions on the shared seam against the other's cells. */
function fitsEast(a: OrientedDesign, b: OrientedDesign, matched: boolean): boolean {
  for (let i = 0; i < S; i++) {
    const near = a.segments.get(`v:${S},${i}`), far = b.segments.get(`v:0,${i}`);
    if (!meets(near?.adjacency, b.cells[i * S]!)) return false;
    if (!meets(far?.adjacency, a.cells[i * S + S - 1]!)) return false;
    if (matched && !passabilityFits(near?.passability, far?.passability)) return false;
  }
  return true;
}
/** `b` south of `a`. */
function fitsSouth(a: OrientedDesign, b: OrientedDesign, matched: boolean): boolean {
  for (let i = 0; i < S; i++) {
    const near = a.segments.get(`h:${i},${S}`), far = b.segments.get(`h:${i},0`);
    if (!meets(near?.adjacency, b.cells[i]!)) return false;
    if (!meets(far?.adjacency, a.cells[(S - 1) * S + i]!)) return false;
    if (matched && !passabilityFits(near?.passability, far?.passability)) return false;
  }
  return true;
}

/**
 * Under `matched` passability (17.2.2), the seams inside a set piece that no pairing of its
 * slots' members fits, so the set piece can never be placed. A slot's members are tried in
 * every orientation it allows. Placement reports these once rather than failing its solves.
 */
export function setPieceSeamProblems(library: ChainLibrary): string[] {
  if (library.passabilityRules !== "matched") return [];
  const oriented = orientedDesigns(library);
  const sets = new Map(library.tileSets.map((set) => [set.id, set]));
  const tiles = new Map(library.tiles.map((tile) => [tile.id, tile]));
  const used = new Set(library.setPieceClasses.flatMap((setPieceClass) => setPieceClass.setPieces));
  const problems: string[] = [];
  for (const piece of library.setPieces) {
    if (!used.has(piece.id)) continue;
    const designs = (slot: ChainSetPiece["tiles"][number]) => (sets.get(slot.tileSetId)?.members ?? []).flatMap((id) =>
      (slot.orientation !== undefined ? [slot.orientation] : tiles.get(id)?.orientations ?? [0])
        .map((orientation) => oriented(id, orientation as Orientation)));
    const at = new Map(piece.tiles.map((slot) => [`${slot.dx},${slot.dy}`, slot]));
    for (const slot of piece.tiles) {
      for (const [dx, dy, fits] of [[1, 0, fitsEast], [0, 1, fitsSouth]] as const) {
        const other = at.get(`${slot.dx + dx},${slot.dy + dy}`);
        if (other && !designs(slot).some((a) => designs(other).some((b) => fits(a, b, true))))
          problems.push(`set piece ${piece.id}: slots ${slot.dx},${slot.dy} and ${other.dx},${other.dy} have no members whose sides fit`);
      }
    }
  }
  return problems;
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
 * - Under `matched` passability rules (17.2.2), each pair of sides on a seam must fit:
 *   `any` (or unstated) fits anything, otherwise like with like. Under `either-side`,
 *   passability can't conflict, so it never constrains the solve.
 */
export function adjacencyCompatibility(library: ChainLibrary): WfcCompatibility {
  const oriented = orientedDesigns(library);
  const of = (option: TileOption) => oriented(option.templateId, option.orientation);
  const matched = library.passabilityRules === "matched";
  return (a, relation, b) => {
    switch (relation) {
      case "E": return fitsEast(of(a), of(b), matched);
      case "W": return fitsEast(of(b), of(a), matched);
      case "S": return fitsSouth(of(a), of(b), matched);
      case "N": return fitsSouth(of(b), of(a), matched);
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

/**
 * What one placement attempt did, for probes and views of the solve (#857): search nodes,
 * open-face refusals, the most refusals between two new depths, and how it ended.
 */
export interface PlacementAttempt { nodes: number; refusals: number; mostStall: number; outcome: "placed" | Failure }

/** One sample: set pieces, then WFC. A failure names what failed, for the final error. */
function sample(
  seed: string, params: ChainParams, library: ChainLibrary, fingerprint: string,
  mask: MaskCell[], zones: Map<string, MapZone>, fill: (zone: MapZone) => ChainTileDesign[],
  random: Stream, openFace: boolean, refused: (reason: string) => void, attempt?: PlacementAttempt, lookahead?: number, trace?: (event: PlacementTraceDetail) => void,
): Layout | Failure {
  const plan = zonePlan(params), { columns, rows } = planTiles(plan, params);
  const designs = new Map(library.tiles.map((tile) => [tile.id, tile]));
  const tileSets = new Map(library.tileSets.map((set) => [set.id, set]));
  const pieces = new Map(library.setPieces.map((piece) => [piece.id, piece]));
  const slotAt = new Map(mask.map((cell, i) => [`${cell.x},${cell.y}`, i]));
  const assigned: Array<{ design: string; orientation: Orientation } | undefined> = new Array(mask.length);
  const instances: SetPieceInstance[] = [];
  // Experimental (#856): only libraries stating it check a piece's sides against pieces already placed.
  const fitPlaced = library.fitPlacedSetPieces === true;
  const oriented = orientedDesigns(library), matched = library.passabilityRules === "matched";
  const fitsPlacedNeighbours = (j: number, id: string, orientation: Orientation): boolean => {
    const here = oriented(id, orientation), { x, y } = mask[j]!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = slotAt.get(`${x + dx},${y + dy}`), there = n === undefined ? undefined : assigned[n];
      if (!there) continue;
      const other = oriented(there.design, there.orientation);
      if (!(dx === 1 ? fitsEast(here, other, matched) : dx === -1 ? fitsEast(other, here, matched)
        : dy === 1 ? fitsSouth(here, other, matched) : fitsSouth(other, here, matched))) return false;
    }
    return true;
  };

  const picks = (params.mode ?? "game") === "game" ? pickSetPieces(library, pieces, plan, columns, rows, random) : [];
  for (const [nth, { setPieceClass, piece, filter }] of picks.entries()) {
    const width = Math.max(...piece.tiles.map((s) => s.dx)) + 1;
    // The members of each slot's tile set eligible in that slot's zone, and allowing the
    // slot's orientation where it fixes one.
    const eligible = (k: number, j: number): ChainTileDesign[] => {
      const zone = zones.get(mask[j]!.zoneId)!, { tileSetId, orientation } = piece.tiles[k]!;
      return tileSets.get(tileSetId)!.members.map((id) => designs.get(id)!).filter((tile) =>
        eligibleIn(tile, zone) && (orientation === undefined || tile.orientations.includes(orientation)));
    };
    // Orientations a slot's member may take; with `fitPlacedSetPieces`, only those fitting placed neighbours.
    const turns = (k: number, j: number, design: ChainTileDesign): Orientation[] => {
      const allowed = (piece.tiles[k]!.orientation !== undefined ? [piece.tiles[k]!.orientation] : design.orientations) as Orientation[];
      return fitPlaced ? allowed.filter((orientation) => fitsPlacedNeighbours(j, design.id, orientation)) : allowed;
    };
    const fitting = (k: number, j: number): ChainTileDesign[] =>
      fitPlaced ? eligible(k, j).filter((design) => turns(k, j, design).length > 0) : eligible(k, j);
    const placements: number[][] = [];
    for (const anchor of mask) {
      if (!filter(anchor, width)) continue;
      const covered = piece.tiles.map((s) => slotAt.get(`${anchor.x + s.dx},${anchor.y + s.dy}`));
      if (covered.every((j, k) => j !== undefined && !assigned[j] &&
        (!piece.eligibleTiers || piece.eligibleTiers.includes(zones.get(mask[j]!.zoneId)!.tier)) &&
        fitting(k, j).length > 0))
        placements.push(covered as number[]);
    }
    if (!placements.length) {
      trace?.({ type: "set-piece-failed", setPiece: piece.id, reason: "no eligible placement" });
      return `set piece ${piece.id}`;
    }
    const covered = random.pick(placements);
    for (const [k, s] of piece.tiles.entries()) {
      const choices = fitting(k, covered[k]!);
      // A slot whose own piece's earlier members left it no fit fails here, as the solve would.
      if (!choices.length) {
        trace?.({ type: "set-piece-failed", setPiece: piece.id, reason: "earlier members left no fitting design" });
        return `set piece ${piece.id}`;
      }
      const design = random.pick(choices);
      const orientation = (s.orientation ?? random.pick(fitPlaced ? turns(k, covered[k]!, design) : design.orientations)) as Orientation;
      assigned[covered[k]!] = { design: design.id, orientation };
      trace?.({ type: "set-piece-slot", instance: `${piece.id}#${nth}`, setPiece: piece.id,
        setPieceClass: setPieceClass.id, slot: covered[k]!, design: design.id, orientation });
    }
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
      templateId: design.id, orientation: orientation as Orientation, difficulty: difficulty(design, library.passabilityRules === "matched"), weight: optionWeight(design, library),
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
  const state = { iterations: 0, maxIterations: wfcIterationCap(grid.length) }, stall = { most: 0 };
  const counted = (reason: string) => { if (attempt) attempt.refusals++; refused(reason); };
  const solved = solveWfc(grid, adjacencyCompatibility(library), () => random.next(),
    { ...(openFace ? { accept: openFaceRule(library, grid, columns, rows, counted, lookahead, trace) } : {}), stallLimit: PLACEMENT_STALL_LIMIT, state, stall, ...(trace ? { trace } : {}) });
  if (attempt) Object.assign(attempt, { nodes: state.iterations, mostStall: stall.most });
  if (!solved) return "wfc";

  const slots: PlacedSlot[] = mask
    .map((cell, i) => ({ col: cell.col, row: cell.row, design: solved[i]!.domain[0]!.templateId, orientation: solved[i]!.domain[0]!.orientation }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  return { seed, params: { ...params }, library: fingerprint, slots, setPieces: instances };
}

/**
 * Placement, with the open-face rule on or off. Only tests switch it off, to show that
 * layouts it would refuse do occur (the PR #110 method). `attempts` hears each attempt's
 * search figures, in order; `lookahead` overrides the open-face rule's (`LOOKAHEAD_CELLS`,
 * 0 for none), for probes and tests comparing them.
 */
export const placer = ({ openFace, attempts, lookahead, trace }: {
  openFace: boolean; attempts?: (attempt: PlacementAttempt) => void; lookahead?: number; trace?: (event: PlacementTraceEvent) => void;
}): MacroStages["placement"] => (seed, params, library) => {
  const mode = params.mode ?? "game";
  const plan = zonePlan(params);
  if (library.zonePlan !== plan.id) throw new Error(`library ${library.name} is authored for ${library.zonePlan}, not ${plan.id}`);
  if (mode === "game" && (library.zoneWidth !== params.zoneWidth || library.zoneHeight !== params.zoneHeight))
    throw new Error(`library ${library.name} is authored for ${library.zoneWidth} x ${library.zoneHeight} tile zones, not ${params.zoneWidth} x ${params.zoneHeight}`);
  const countError = countParamsProblem(params);
  if (countError) throw new Error(countError);
  const zones = new Map(makeZones(params, plan).map((zone) => [zone.id, zone]));
  const mask = layoutSlots(params, plan);

  // A core element class is painted only inside its owning set pieces (51, "Core elements"), so
  // the fill never places a design that paints one. Nor one weighted 0, which only set pieces place (52).
  const featureClasses = new Set(Object.entries(library.cellClasses)
    .filter(([, cellClass]) => Object.keys(cellClass.coreElements ?? {}).length).map(([id]) => id));
  const paintsFeature = (tile: ChainTileDesign): boolean =>
    featureClasses.has(tile.defaultCellClass) || Object.values(tile.legend ?? {}).some((id) => featureClasses.has(id));

  // Problems no retry can fix are reported once, not fifty times.
  const seams = setPieceSeamProblems(library);
  if (seams.length) throw new Error(`${seams.join("; ")} (matched passability, 17.2.2)`);
  const fillByZone = new Map<string, ChainTileDesign[]>();
  for (const zone of zones.values()) {
    const eligible = library.tiles.filter((tile) => !paintsFeature(tile) && fillable(tile) && eligibleIn(tile, zone));
    if (!eligible.length) throw new Error(`no tile design is eligible for zone ${zone.id} (tier ${zone.tier}, bonus ${zone.bonus})`);
    fillByZone.set(zone.id, eligible);
  }
  if (mode === "game") for (const setPieceClass of library.setPieceClasses)
    if (setPieceClass.placementRule === "enormous" && setPieceClass.setPieces.length < setPieceClass.quota)
      throw new Error(`set piece class ${setPieceClass.id} needs ${setPieceClass.quota} distinct set pieces and has ${setPieceClass.setPieces.length}`);

  const fingerprint = libraryFingerprint(library);
  const failures = new Map<Failure, number>();
  let refusal: string | undefined;
  for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
    const record: PlacementAttempt | undefined = attempts || trace ? { nodes: 0, refusals: 0, mostStall: 0, outcome: "wfc" } : undefined;
    const emit: ((event: PlacementTraceDetail) => void) | undefined = trace ? (event) => trace({ ...event, attempt }) : undefined;
    if (emit) emit({ type: "attempt-start", slots: mask.map((cell, slot) => ({ slot, x: cell.x, y: cell.y, col: cell.col, row: cell.row })) });
    const result = sample(seed, params, library, fingerprint, mask, zones, (zone) => fillByZone.get(zone.id)!,
      stream(seed, "placement", attempt), openFace, (reason) => { refusal = reason; }, record, lookahead, emit);
    if (record) {
      const outcome = typeof result === "string" ? result : "placed";
      attempts?.({ ...record, outcome });
      emit?.({ type: "attempt-end", outcome, nodes: record.nodes, mostStall: record.mostStall });
    }
    if (typeof result !== "string") return result;
    failures.set(result, (failures.get(result) ?? 0) + 1);
  }
  const detail = [...failures].map(([failure, count]) => `${failure} (${count}/${PLACEMENT_ATTEMPTS})`).join(", ");
  const last = refusal === undefined ? "" : `; the open-face rule last refused: ${refusal}`;
  throw new Error(`placement found no valid layout for seed ${seed}: ${detail}${last}`);
};

export const placement = placer({ openFace: true });
