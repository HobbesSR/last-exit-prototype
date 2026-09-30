/** The chain's authored library (51 stage 0, 52). It is independent of the old library. */
export const CHAIN_LIBRARY_VERSION = 1;
export const CHAIN_TILE_SIZE = 6;

export type Side = "N" | "E" | "S" | "W";
export type PassabilityPrescription = "passable" | "any";
export type Feature = "spawn" | "hunter-spawn" | "exit" | "charger" | "warp";
export type FeatureCount = number | "exitCount";
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
  /** Features this region's strategy sites; delivery is measured after build. */
  features?: Partial<Record<Feature, FeatureCount>>;
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
  features?: Partial<Record<Feature, FeatureCount>>;
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
const FEATURES = new Set<Feature>(["spawn", "hunter-spawn", "exit", "charger", "warp"]);

function featureErrors(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!object(value)) {
    errors.push(`${path}: features must be an object`);
    return;
  }
  for (const [feature, count] of Object.entries(value)) {
    if (!FEATURES.has(feature as Feature)) errors.push(`${path}: unknown feature ${feature}`);
    if (!(integer(count) && count > 0) && count !== "exitCount")
      errors.push(`${path}: feature ${feature} count must be a positive integer or exitCount`);
  }
}

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

function isClass(value: unknown, declared: Set<string>): boolean {
  return value === "any" || (name(value) && declared.has(value));
}
const resolvedClass = (value: string): string => value === "any" ? "open" : value;

/** Segment line and offset; all indices are in tile-local cell units. */
function segmentAddress(key: string): { vertical: boolean; line: number; offset: number } | undefined {
  const match = /^([vh]):(\d+),(\d+)$/.exec(key);
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
  if (!object(tile.segments)) return;
  // A boundary between differently classed cells can yield a portal. Scan
  // each side independently: a change of class breaks a straight run.
  for (const vertical of [true, false]) for (let line = 1; line < CHAIN_TILE_SIZE; line++) {
    for (const after of [false, true]) {
      let runClass = "", from = -1;
      const finish = (to: number) => {
        if (from < 0) return;
        if (to - from < minRun && from > 0 && to < CHAIN_TILE_SIZE)
          errors.push(`${path}: short passable run ${vertical ? "v" : "h"}:${line},${from}..${to - 1} for class ${runClass} lies wholly inside tile (minimum ${minRun})`);
        from = -1;
      };
      for (let offset = 0; offset <= CHAIN_TILE_SIZE; offset++) {
        let current = "";
        if (offset < CHAIN_TILE_SIZE) {
          const x = vertical ? line - (after ? 0 : 1) : offset;
          const y = vertical ? offset : line - (after ? 0 : 1);
          const otherX = vertical ? line - (after ? 1 : 0) : offset;
          const otherY = vertical ? offset : line - (after ? 1 : 0);
          const mine = resolvedClass(classes[y * CHAIN_TILE_SIZE + x]!);
          const other = resolvedClass(classes[otherY * CHAIN_TILE_SIZE + otherX]!);
          const key = `${vertical ? "v" : "h"}:${line},${offset}`;
          const prescription = tile.segments[key];
          if (mine !== other && object(prescription) && prescription.passability === "passable")
            current = mine;
        }
        if (current !== runClass) {
          finish(offset);
          runClass = current;
          if (current) from = offset;
        }
      }
    }
  }
}

/** Pure, exhaustive authoring checks. Region type IDs are supplied until C1. */
export function validateLibrary(
  library: unknown,
  regionTypeIds: ReadonlySet<string>,
  minPassableRun = 2,
): LibraryValidation {
  const errors: string[] = [];
  if (!object(library)) return { valid: false, errors: ["library: must be an object"] };
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
      if (value.params !== undefined && (!object(value.params) ||
        !Object.values(value.params).every((v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))))
        errors.push(`cell class ${id}: malformed params`);
      featureErrors(value.features, `cell class ${id}`, errors);
    }
  }
  if (!declared.has("open")) errors.push("cellClasses: missing privileged open class");

  const tileIds = uniqueIds(library.tiles, "tiles", errors);
  if (Array.isArray(library.tiles)) for (const [i, raw] of library.tiles.entries()) {
    if (!object(raw)) continue;
    const path = `tile ${name(raw.id) ? raw.id : i}`;
    const classes = tileClasses(raw, declared, path, errors);
    if (!Array.isArray(raw.orientations) || raw.orientations.length === 0 ||
      !raw.orientations.every((v) => ORIENTATIONS.has(v)) || new Set(raw.orientations).size !== raw.orientations.length)
      errors.push(`${path}: malformed orientations`);
    for (const field of ["eligibleTiers", "eligibleBonus"])
      if (raw[field] !== undefined && (!Array.isArray(raw[field]) || !raw[field].every((v: unknown) => integer(v) && v >= 0 && v <= 5)))
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
    if (integer(minPassableRun) && minPassableRun > 0) shortInteriorRuns(raw, classes, minPassableRun, path, errors);
  }

  const tileSetIds = uniqueIds(library.tileSets, "tileSets", errors);
  if (Array.isArray(library.tileSets)) for (const raw of library.tileSets) if (object(raw)) {
    if (!names(raw.members) || raw.members.length === 0) errors.push(`tile set ${String(raw.id)}: missing members`);
    else for (const id of raw.members) if (!tileIds.has(id)) errors.push(`tile set ${String(raw.id)}: unknown tile ${id}`);
  }

  const setPieceIds = uniqueIds(library.setPieces, "setPieces", errors);
  if (Array.isArray(library.setPieces)) for (const raw of library.setPieces) if (object(raw)) {
    const path = `set piece ${String(raw.id)}`;
    if (raw.primaryRegionClass !== undefined && !(name(raw.primaryRegionClass) && declared.has(raw.primaryRegionClass)))
      errors.push(`${path}: primaryRegionClass is not declared`);
    if (!Array.isArray(raw.tiles) || raw.tiles.length === 0) errors.push(`${path}: missing tile slots`);
    else for (const [i, slot] of raw.tiles.entries()) {
      if (!object(slot) || !integer(slot.dx) || !integer(slot.dy) || !name(slot.tileSetId) || !tileSetIds.has(slot.tileSetId))
        errors.push(`${path}: malformed slot ${i}`);
      if (object(slot) && slot.orientation !== undefined && !ORIENTATIONS.has(slot.orientation as number))
        errors.push(`${path}: malformed slot orientation ${i}`);
    }
    if (raw.eligibleTiers !== undefined && (!Array.isArray(raw.eligibleTiers) ||
      !raw.eligibleTiers.every((v: unknown) => integer(v) && v >= 1 && v <= 5)))
      errors.push(`${path}: malformed eligibleTiers`);
  }

  uniqueIds(library.setPieceClasses, "setPieceClasses", errors);
  if (Array.isArray(library.setPieceClasses)) for (const raw of library.setPieceClasses) if (object(raw)) {
    const path = `set piece class ${String(raw.id)}`;
    if (!PLACEMENT_RULES.has(raw.placementRule as PlacementRule)) errors.push(`${path}: missing or unknown placement rule`);
    if (!integer(raw.quota) || raw.quota < 1) errors.push(`${path}: quota must be positive`);
    if (!names(raw.setPieces) || raw.setPieces.length === 0) errors.push(`${path}: missing set pieces`);
    else for (const id of raw.setPieces) if (!setPieceIds.has(id)) errors.push(`${path}: unknown set piece ${id}`);
    featureErrors(raw.features, path, errors);
  }
  return { valid: errors.length === 0, errors };
}
