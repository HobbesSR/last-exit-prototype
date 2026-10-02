/** The chain's authored library (51 stage 0, 52). It is independent of the old library. */
import { CORE_ELEMENT_KINDS } from "../../../kernel/contract.ts";
import type { CoreElementKind } from "../../../kernel/contract.ts";
import { boundaryRuns } from "../../../kernel/run.ts";
import { MIN_PORTAL_LENGTH } from "../../../kernel/scale.ts";
export const CHAIN_LIBRARY_VERSION = 2;
export const CHAIN_TILE_SIZE = 6;

export type Side = "N" | "E" | "S" | "W";
export type PassabilityPrescription = "passable" | "any";
/** Map params a core element count may name, resolved from the Layout's params (52). */
export const COUNT_PARAMS = ["exitCount", "contestantCount"] as const;
export type CountParam = typeof COUNT_PARAMS[number];
export type CoreElementCount = number | CountParam;
export type PlacementRule = "start" | "end" | "enormous" | "medium" | "small" | "charger";

/** Each perimeter segment can require the class across its tile boundary. */
export interface SegmentPrescription {
  adjacency?: string;
  /** Omission is distinct from an authored `any`. */
  passability?: PassabilityPrescription;
}

export interface ChainCellClass {
  regionType: string;
  params?: Record<string, number | string | boolean>;
  /** Core elements this region's strategy sites; delivery is measured after build. */
  coreElements?: Partial<Record<CoreElementKind, CoreElementCount>>;
}

export interface ChainTileDesign {
  id: string;
  defaultCellClass: string;
  /** Six rows of six marks. A dot uses the default; another mark uses the legend. */
  cells?: string[];
  legend?: Record<string, string>;
  /** v:x,y for a vertical segment; h:y,x for a horizontal one. */
  segments?: Record<string, SegmentPrescription>;
  orientations: number[];
  eligibleTiers?: number[];
  eligibleBonus?: number[];
  labels?: string[];
  weight?: number;
}

export interface ChainTileSet {
  id: string;
  members: string[];
}

export interface ChainSetPieceSlot {
  dx: number;
  dy: number;
  tileSetId: string;
  orientation?: number;
}

export interface ChainSetPiece {
  id: string;
  tiles: ChainSetPieceSlot[];
  eligibleTiers?: number[];
  /** Editor hint only; placement does not read it. */
  primaryRegionClass?: string;
}

export interface ChainSetPieceClass {
  id: string;
  placementRule: PlacementRule;
  quota: number;
  setPieces: string[];
  coreElements?: Partial<Record<CoreElementKind, CoreElementCount>>;
}

export interface ChainLibrary {
  version: typeof CHAIN_LIBRARY_VERSION;
  cellClasses: Record<string, ChainCellClass>;
  tiles: ChainTileDesign[];
  tileSets: ChainTileSet[];
  setPieces: ChainSetPiece[];
  setPieceClasses: ChainSetPieceClass[];
}

export interface LibraryValidation {
  valid: boolean;
  errors: string[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(name);
const ORIENTATIONS = new Set([0, 90, 180, 270]);
const PLACEMENT_RULES = new Set<PlacementRule>(["start", "end", "enormous", "medium", "small", "charger"]);
const CORE_ELEMENTS = new Set<CoreElementKind>(CORE_ELEMENT_KINDS);

function unknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  for (const field of Object.keys(value))
    if (!allowed.includes(field)) errors.push(`${path}: unknown field ${field}`);
}

function coreElementErrors(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!object(value)) {
    errors.push(`${path}: core elements must be an object`);
    return;
  }
  for (const [element, count] of Object.entries(value)) {
    if (!CORE_ELEMENTS.has(element as CoreElementKind)) errors.push(`${path}: unknown core element ${element}`);
    if (!(integer(count) && count > 0) && !COUNT_PARAMS.includes(count as CountParam))
      errors.push(`${path}: core element ${element} count must be a positive integer or one of ${COUNT_PARAMS.join(", ")}`);
  }
}

/**
 * Why the params can't resolve every count a core element may name, or `undefined`. A
 * brief's counts are whole numbers (the contract), with no ceiling.
 */
export function countParamsProblem(params: Record<CountParam, number>): string | undefined {
  const bad = COUNT_PARAMS.find((name) => !(Number.isSafeInteger(params[name]) && params[name] >= 0));
  return bad && `${bad} must be a whole number, not ${params[bad]}`;
}

/** A core element count as a whole number: as written, or the params' value it names. */
export const resolveCount = (count: CoreElementCount, params: Record<CountParam, number>): number =>
  typeof count === "number" ? count : params[count];

function uniqueIds(value: unknown, path: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) {
    errors.push(`${path}: must be an array`);
    return ids;
  }
  value.forEach((entry, i) => {
    if (!object(entry) || !name(entry.id)) {
      errors.push(`${path}[${i}]: missing id`);
    } else if (ids.has(entry.id)) {
      errors.push(`${path}: duplicate id ${entry.id}`);
    } else ids.add(entry.id);
  });
  return ids;
}

/** Each id listed more than once. Tile sets and set piece classes are sets (52). */
function repeated(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

function isClass(value: unknown, declared: Set<string>): boolean {
  return value === "any" || (name(value) && declared.has(value));
}
const resolvedClass = (value: string): string => value === "any" ? "open" : value;

/** Segment line and offset; all indices are in tile-local cell units. */
function segmentAddress(key: string): { vertical: boolean; line: number; offset: number } | undefined {
  const match = /^([vh]):(0|[1-9]\d*),(0|[1-9]\d*)$/.exec(key);
  if (!match) return undefined;
  const line = Number(match[2]), offset = Number(match[3]);
  if (line > CHAIN_TILE_SIZE || offset >= CHAIN_TILE_SIZE) return undefined;
  return { vertical: match[1] === "v", line, offset };
}

function tileClasses(tile: Record<string, unknown>, declared: Set<string>, path: string, errors: string[]): string[] {
  const base = tile.defaultCellClass;
  if (!isClass(base, declared)) errors.push(`${path}: undeclared default cell class ${String(base)}`);
  const legend = tile.legend;
  if (legend !== undefined && !object(legend)) errors.push(`${path}: legend must be an object`);
  if (object(legend)) for (const [mark, value] of Object.entries(legend)) {
    if (mark.length !== 1 || mark === ".") errors.push(`${path}: malformed legend mark ${mark}`);
    if (!isClass(value, declared)) errors.push(`${path}: undeclared cell class ${String(value)} in legend ${mark}`);
  }
  const grid = tile.cells;
  if (grid !== undefined && (!Array.isArray(grid) || grid.length !== CHAIN_TILE_SIZE ||
    !grid.every((row) => typeof row === "string" && row.length === CHAIN_TILE_SIZE))) {
    errors.push(`${path}: cells must contain six rows of six marks`);
  }
  const result: string[] = [];
  for (let y = 0; y < CHAIN_TILE_SIZE; y++) for (let x = 0; x < CHAIN_TILE_SIZE; x++) {
    const mark = Array.isArray(grid) && typeof grid[y] === "string" ? grid[y][x] : ".";
    if (mark !== "." && (!object(legend) || !name(legend[mark]))) {
      errors.push(`${path}: unknown cell mark ${String(mark)} at ${x},${y}`);
    }
    result.push(mark === "." ? String(base) : String(object(legend) ? legend[mark] : ""));
  }
  return result;
}

function shortInteriorRuns(tile: Record<string, unknown>, classes: string[], minRun: number, path: string, errors: string[]): void {
  const segments = tile.segments;
  if (!object(segments)) return;
  // The shared finder splits whenever either class changes. A passable stretch
  // is then a contiguous subset of one boundary run, never a bridge across
  // distinct class pairs.
  const cellsByClass = new Map<string, { x: number; y: number }[]>();
  classes.forEach((value, index) => {
    const id = resolvedClass(value);
    if (!cellsByClass.has(id)) cellsByClass.set(id, []);
    cellsByClass.get(id)!.push({ x: index % CHAIN_TILE_SIZE, y: Math.floor(index / CHAIN_TILE_SIZE) });
  });
  const boundaries = boundaryRuns([...cellsByClass].map(([id, cells]) => ({ id, cells })));
  for (const boundary of boundaries) for (const run of boundary.runs) {
    const line = run.axis === "v" ? run.x : run.y;
    const start = run.axis === "v" ? run.y : run.x;
    const end = start + run.length;
    // A perimeter `any` cell can adopt a neighbour's required class at
    // placement. Its authored class cannot establish a boundary here; the
    // resolved layout check owns any resulting portal.
    const uncertain = Array.from({ length: run.length }, (_, i) => {
      const offset = start + i;
      const prescription = segments[`${run.axis}:${line},${offset}`];
      if (!object(prescription) || prescription.passability !== "passable") return false;
      const adjacent = run.axis === "v"
        ? [{ x: line - 1, y: offset }, { x: line, y: offset }]
        : [{ x: offset, y: line - 1 }, { x: offset, y: line }];
      return adjacent.some(({ x, y }) => classes[y * CHAIN_TILE_SIZE + x] === "any" &&
        (x === 0 || y === 0 || x === CHAIN_TILE_SIZE - 1 || y === CHAIN_TILE_SIZE - 1));
    });
    if (uncertain.some(Boolean)) continue;
    let from = -1;
    const finish = (to: number) => {
      if (from >= 0 && to - from < minRun && from > 0 && to < CHAIN_TILE_SIZE)
        errors.push(`${path}: short passable run ${run.axis}:${line},${from}..${to - 1} for classes ${boundary.a}|${boundary.b} lies wholly inside tile (minimum ${minRun})`);
      from = -1;
    };
    for (let offset = start; offset <= end; offset++) {
      const key = `${run.axis}:${line},${offset}`;
      const prescription = segments[key];
      if (offset < end && object(prescription) && prescription.passability === "passable") {
        if (from < 0) from = offset;
      } else finish(offset);
    }
  }
}

/** Pure, exhaustive authoring checks. Region type IDs are supplied until C1. */
export function validateLibrary(
  library: unknown,
  regionTypeIds: ReadonlySet<string>,
  minPassableRun = MIN_PORTAL_LENGTH,
): LibraryValidation {
  const errors: string[] = [];
  if (!object(library)) return { valid: false, errors: ["library: must be an object"] };
  unknownFields(library, ["version", "cellClasses", "tiles", "tileSets", "setPieces", "setPieceClasses"], "library", errors);
  if (library.version !== CHAIN_LIBRARY_VERSION) errors.push(`library: unsupported version ${String(library.version)}`);
  if (!integer(minPassableRun) || minPassableRun < 1) errors.push("minimum passable run must be a positive integer");
  const declared = new Set<string>();
  if (!object(library.cellClasses)) errors.push("cellClasses: must be an object");
  else for (const [id, value] of Object.entries(library.cellClasses)) {
    if (!name(id) || id === "any" || id === "") errors.push(`cellClasses: reserved class ${id}`);
    declared.add(id);
    if (!object(value) || !name(value.regionType) || !regionTypeIds.has(value.regionType))
      errors.push(`cell class ${id}: names no known region type`);
    if (object(value)) {
      unknownFields(value, ["regionType", "params", "coreElements"], `cell class ${id}`, errors);
      if (value.params !== undefined && (!object(value.params) ||
        !Object.values(value.params).every((v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))))
        errors.push(`cell class ${id}: malformed params`);
      coreElementErrors(value.coreElements, `cell class ${id}`, errors);
    }
  }
  if (!declared.has("open")) errors.push("cellClasses: missing privileged open class");

  const tileIds = uniqueIds(library.tiles, "tiles", errors);
  if (Array.isArray(library.tiles)) for (const [i, raw] of library.tiles.entries()) {
    if (!object(raw)) continue;
    const path = `tile ${name(raw.id) ? raw.id : i}`;
    unknownFields(raw, ["id", "defaultCellClass", "cells", "legend", "segments", "orientations", "eligibleTiers", "eligibleBonus", "labels", "weight"], path, errors);
    const classes = tileClasses(raw, declared, path, errors);
    if (!Array.isArray(raw.orientations) || raw.orientations.length === 0 ||
      !raw.orientations.every((v) => ORIENTATIONS.has(v)) || new Set(raw.orientations).size !== raw.orientations.length)
      errors.push(`${path}: malformed orientations`);
    for (const field of ["eligibleTiers", "eligibleBonus"])
      if (raw[field] !== undefined && (!Array.isArray(raw[field]) || !raw[field].every((v: unknown) => integer(v) && v >= (field === "eligibleTiers" ? 1 : 0) && v <= 5)))
        errors.push(`${path}: malformed ${field}`);
    if (raw.labels !== undefined && !names(raw.labels)) errors.push(`${path}: malformed labels`);
    if (raw.weight !== undefined && !(typeof raw.weight === "number" && Number.isFinite(raw.weight) && raw.weight > 0))
      errors.push(`${path}: malformed weight`);
    if (raw.segments !== undefined && !object(raw.segments)) errors.push(`${path}: segments must be an object`);
    if (object(raw.segments)) for (const [key, value] of Object.entries(raw.segments)) {
      const address = segmentAddress(key);
      if (!address || !object(value)) {
        errors.push(`${path}: malformed segment prescription ${key}`);
        continue;
      }
      for (const property of Object.keys(value)) if (property !== "adjacency" && property !== "passability")
        errors.push(`${path}: malformed segment prescription ${key}: unknown ${property}`);
      if (value.adjacency !== undefined) {
        if (address.line !== 0 && address.line !== CHAIN_TILE_SIZE)
          errors.push(`${path}: adjacency on non-perimeter segment ${key}`);
        if (!isClass(value.adjacency, declared))
          errors.push(`${path}: malformed adjacency ${key}: ${String(value.adjacency)}`);
      }
      if (value.passability !== undefined && value.passability !== "passable" && value.passability !== "any")
        errors.push(`${path}: malformed passability ${key}: ${String(value.passability)}`);
    }
    if (integer(minPassableRun) && minPassableRun > 0 && classes.every(name))
      shortInteriorRuns(raw, classes, minPassableRun, path, errors);
  }

  const tileSetIds = uniqueIds(library.tileSets, "tileSets", errors);
  if (Array.isArray(library.tileSets)) for (const raw of library.tileSets) if (object(raw)) {
    unknownFields(raw, ["id", "members"], `tile set ${String(raw.id)}`, errors);
    if (!names(raw.members) || raw.members.length === 0) errors.push(`tile set ${String(raw.id)}: missing members`);
    else {
      for (const id of raw.members) if (!tileIds.has(id)) errors.push(`tile set ${String(raw.id)}: unknown tile ${id}`);
      for (const id of repeated(raw.members)) errors.push(`tile set ${String(raw.id)}: repeated member ${id}`);
    }
  }

  const tileOrientations = new Map<string, unknown[]>();
  if (Array.isArray(library.tiles)) for (const raw of library.tiles)
    if (object(raw) && name(raw.id) && Array.isArray(raw.orientations)) tileOrientations.set(raw.id, raw.orientations);
  const tileSetMembers = new Map<string, string[]>();
  if (Array.isArray(library.tileSets)) for (const raw of library.tileSets)
    if (object(raw) && name(raw.id) && names(raw.members)) tileSetMembers.set(raw.id, raw.members);

  const setPieceIds = uniqueIds(library.setPieces, "setPieces", errors);
  if (Array.isArray(library.setPieces)) for (const raw of library.setPieces) if (object(raw)) {
    const path = `set piece ${String(raw.id)}`;
    unknownFields(raw, ["id", "tiles", "eligibleTiers", "primaryRegionClass"], path, errors);
    if (raw.primaryRegionClass !== undefined && !(name(raw.primaryRegionClass) && declared.has(raw.primaryRegionClass)))
      errors.push(`${path}: primaryRegionClass is not declared`);
    if (!Array.isArray(raw.tiles) || raw.tiles.length === 0) errors.push(`${path}: missing tile slots`);
    else {
      const occupied = new Set<string>();
      for (const [i, slot] of raw.tiles.entries()) {
        if (object(slot)) {
          unknownFields(slot, ["dx", "dy", "tileSetId", "orientation"], `${path} slot ${i}`, errors);
          if (integer(slot.dx) && integer(slot.dy)) {
            const position = `${slot.dx},${slot.dy}`;
            if (occupied.has(position)) errors.push(`${path}: duplicate slot ${position}`);
            occupied.add(position);
          }
        }
        if (!object(slot) || !integer(slot.dx) || !integer(slot.dy) || !name(slot.tileSetId) || !tileSetIds.has(slot.tileSetId))
          errors.push(`${path}: malformed slot ${i}`);
        if (object(slot) && slot.orientation !== undefined && !ORIENTATIONS.has(slot.orientation as number))
          errors.push(`${path}: malformed slot orientation ${i}`);
        else if (object(slot) && slot.orientation !== undefined && name(slot.tileSetId)) {
          // A fixed orientation must suit some member, or the slot can never be filled.
          const members = tileSetMembers.get(slot.tileSetId);
          if (members?.every((id) => tileOrientations.get(id)?.includes(slot.orientation) === false))
            errors.push(`${path}: slot ${i} orientation ${String(slot.orientation)} suits no member of tile set ${slot.tileSetId}`);
        }
      }
    }
    if (raw.eligibleTiers !== undefined && (!Array.isArray(raw.eligibleTiers) ||
      !raw.eligibleTiers.every((v: unknown) => integer(v) && v >= 1 && v <= 5)))
      errors.push(`${path}: malformed eligibleTiers`);
  }

  uniqueIds(library.setPieceClasses, "setPieceClasses", errors);
  if (Array.isArray(library.setPieceClasses)) for (const raw of library.setPieceClasses) if (object(raw)) {
    const path = `set piece class ${String(raw.id)}`;
    unknownFields(raw, ["id", "placementRule", "quota", "setPieces", "coreElements"], path, errors);
    if (!PLACEMENT_RULES.has(raw.placementRule as PlacementRule)) errors.push(`${path}: missing or unknown placement rule`);
    if (!integer(raw.quota) || raw.quota < 1) errors.push(`${path}: quota must be positive`);
    if (!names(raw.setPieces) || raw.setPieces.length === 0) errors.push(`${path}: missing set pieces`);
    else {
      for (const id of raw.setPieces) if (!setPieceIds.has(id)) errors.push(`${path}: unknown set piece ${id}`);
      for (const id of repeated(raw.setPieces)) errors.push(`${path}: repeated set piece ${id}`);
    }
    coreElementErrors(raw.coreElements, path, errors);
  }
  return { valid: errors.length === 0, errors };
}
