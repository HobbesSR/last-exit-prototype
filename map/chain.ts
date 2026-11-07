/** The game's entry point for the generation chain (51): macro placement through micro construction. */
import diamond12x6 from './macro/content/diamond-12x6.json' with { type: 'json' };
import diamond24x12 from './macro/content/diamond-24x12.json' with { type: 'json' };
import diamond36x18 from './macro/content/diamond-36x18.json' with { type: 'json' };
import commonPrimitives from './macro/content/common-primitives@5.json' with { type: 'json' };
import commonSetPieces from './macro/content/common-set-pieces@5.json' with { type: 'json' };
import districtSetPieces from './macro/content/district-set-pieces@4.json' with { type: 'json' };
import { resolveLibrary, validateLibrary as validateChainLibrary } from './macro/src/chain/library.ts';
import type { ChainLibrary, LibraryValidation } from './macro/src/chain/library.ts';
import { generateChainMap } from './macro/src/chain/map.ts';
import { DEFAULT_CHAIN_PARAMS, placement, setPieceSeamProblems } from './macro/src/chain/placement.ts';
import type { ChainMap, ChainParams } from './macro/src/chain/types.ts';
import type { RegionElement } from './micro/types.ts';
import { DEFAULT_CELL_SIZE, GAME_ENGINES, GAME_REGION_TYPES } from './engines.ts';
import { isCellSize } from './kernel/scale.ts';

export type GameChainMap = ChainMap<RegionElement>;

const MODULES = {
  'common-primitives@5': commonPrimitives, 'common-set-pieces@5': commonSetPieces,
  'district-set-pieces@4': districtSetPieces,
};

/** The bundled libraries, one per zone size the diamond is authored for (55), default first. */
export const CHAIN_LIBRARIES: readonly ChainLibrary[] = Object.freeze(
  [diamond12x6, diamond24x12, diamond36x18].map((top) => resolveLibrary(top, MODULES)));

/** Classes whose tile edges the matched libraries hint wherever an edge segment states `any` or nothing (#849). */
const CLOSED_EDGE_CLASSES = new Set(['rubble']);

/**
 * Hints each perimeter segment of `tile` that states `any` or nothing beside a cell of one of
 * `classes` (52.1): under matched passability `any` meeting `any` between two regions is a
 * portal, so an all-`any` rubble edge opened its whole side. Authored `passable` stays.
 */
function hintEdgesBeside(tile: ChainLibrary['tiles'][number], classes: ReadonlySet<string>): void {
  const at = (x: number, y: number) => {
    const mark = tile.cells?.[y]?.[x] ?? '.';
    return mark === '.' ? tile.defaultCellClass : tile.legend?.[mark] ?? tile.defaultCellClass;
  };
  for (let i = 0; i < 6; i++) {
    // The library writes `h:line,offset`: north h:0, south h:6, west v:0, east v:6.
    for (const [key, x, y] of [[`h:0,${i}`, i, 0], [`h:6,${i}`, i, 5], [`v:0,${i}`, 0, i], [`v:6,${i}`, 5, i]] as const) {
      const passability = tile.segments?.[key]?.passability;
      if (!classes.has(at(x, y)) || (passability !== undefined && passability !== 'any')) continue;
      (tile.segments ??= {})[key] = { ...tile.segments[key], passability: 'not-passable-hint' };
    }
  }
}

/** Classes given a rotatable family of edge tiles in the matched libraries (#849). */
const EDGE_FAMILY_CLASSES = ['cover', 'park', 'rubble'];

/**
 * Whole tiles of `cellClass`, rotatable, each with one fully hinted north side (Corey, 2026-11-06):
 * `-corner` also hints the east and leaves the south and west `any`; `-edge` leaves the other
 * three `any`; `-through` makes the south passable and leaves the east and west `any`. An `any`
 * side fits any neighbour, so a hinted side can continue a neighbour's closed run, or open.
 */
function edgeFamily(cellClass: string): ChainLibrary['tiles'] {
  const side = (line: string, passability: 'any' | 'passable' | 'not-passable-hint') =>
    Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`${line},${i}`, { passability }]));
  const tile = (shape: string, east: 'any' | 'not-passable-hint', south: 'any' | 'passable') => ({
    id: `${cellClass}-${shape}`, defaultCellClass: cellClass, orientations: [0, 90, 180, 270], weight: 1,
    segments: { ...side('h:0', 'not-passable-hint'), ...side('v:6', east), ...side('h:6', south), ...side('v:0', 'any') },
  }) as ChainLibrary['tiles'][number];
  return [tile('corner', 'not-passable-hint', 'any'), tile('edge', 'any', 'any'), tile('through', 'any', 'passable')];
}

/** Fill tiles given closed-side variants in the matched libraries (#849, stage 2 draft). */
const CLOSED_SIDE_TILES = ['cover-ground', 'park-ground'];
/** The share of each such tile's fill weight its variants take, split evenly among them. */
const CLOSED_SIDE_SHARE = 0.5;
const SIDE_KEYS = { N: 'h:0', S: 'h:6', W: 'v:0', E: 'v:6' } as const;

/**
 * Variants of `tile` with every segment of one side, or of two sides, hinted (52.1): under
 * matched passability such a side meets only a hinted or `any` side, so it closes the whole
 * seam. They take `share` of the tile's weight, and the tile keeps the rest as the fallback.
 */
function closedSideVariants(tile: ChainLibrary['tiles'][number], share: number): ChainLibrary['tiles'] {
  const sides = Object.keys(SIDE_KEYS) as (keyof typeof SIDE_KEYS)[];
  const sets = [...sides.map((side) => [side]), ...sides.flatMap((a, i) => sides.slice(i + 1).map((b) => [a, b]))];
  const weight = tile.weight ?? 1;
  tile.weight = weight * (1 - share);
  return sets.map((closed) => {
    const variant = structuredClone(tile);
    variant.id = `${tile.id}-closed-${closed.join('').toLowerCase()}`;
    variant.weight = weight * share / sets.length;
    for (const side of closed) for (let i = 0; i < 6; i++)
      (variant.segments ??= {})[`${SIDE_KEYS[side]},${i}`] = { passability: 'not-passable-hint' };
    return variant;
  });
}

/**
 * Hints every unstated segment inside `tile` between two cells it declares as different
 * classes, at least one of them concrete (52.1). Under matched passability an unstated one
 * there would be passable (17.2.2); the bundled tiles were authored before that default, so
 * their silence meant no promise, and a stretch meant to be open is already `passable`.
 */
function hintUnstatedInnerEdges(tile: ChainLibrary['tiles'][number]): void {
  const at = (x: number, y: number) => {
    const mark = tile.cells?.[y]?.[x] ?? '.';
    return mark === '.' ? tile.defaultCellClass : tile.legend?.[mark] ?? tile.defaultCellClass;
  };
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    // The library writes `h:line,offset` (52, "Coordinates").
    for (const [key, nx, ny] of [[`v:${x + 1},${y}`, x + 1, y], [`h:${y + 1},${x}`, x, y + 1]] as const) {
      if (nx > 5 || ny > 5) continue;
      const a = at(x, y), b = at(nx, ny);
      if (a === b || (a === 'any' && b === 'any') || tile.segments?.[key]?.passability !== undefined) continue;
      (tile.segments ??= {})[key] = { ...tile.segments[key], passability: 'not-passable-hint' };
    }
  }
}

/**
 * Experimental (#849): each bundled library under `matched` passability (17.2.2). Its one
 * content change is `clear-rubble-center` stating `any`, not `passable`, on its edges, so
 * `rubble-court`'s cover tiles can still meet it. Nothing generates with these unless asked:
 * the Map Lab offers them as a library source. Adoption is a separate, versioned batch (31).
 */
export const MATCHED_LIBRARIES: readonly ChainLibrary[] = Object.freeze(CHAIN_LIBRARIES.map((bundled) => {
  const library: ChainLibrary = { ...structuredClone(bundled), name: `${bundled.name}-matched`, passabilityRules: 'matched' };
  const centre = library.tiles.find((tile) => tile.id === 'clear-rubble-center');
  for (const [key, prescription] of Object.entries(centre?.segments ?? {})) {
    const line = Number(key.split(':')[1]!.split(',')[0]);
    if ((line === 0 || line === 6) && prescription.passability === 'passable') prescription.passability = 'any';
  }
  // Every authored tile weighs 1, and `fillable: false` replaces weight 0 (Corey, 2026-11-06, 17.2.2).
  for (const tile of library.tiles) {
    if (tile.weight === 0) tile.fillable = false;
    tile.weight = 1;
  }
  // Stage 2 draft: tiles authored before the unstated default keep their designed crossings.
  for (const tile of library.tiles) hintUnstatedInnerEdges(tile);
  for (const tile of library.tiles) hintEdgesBeside(tile, CLOSED_EDGE_CLASSES);
  // Rotatable edge families for the classes the fill places (Corey, 2026-11-06).
  for (const cellClass of EDGE_FAMILY_CLASSES) if (library.cellClasses[cellClass]) library.tiles.push(...edgeFamily(cellClass));
  // Stage 3 draft (#838): cover and park wall their hinted edges.
  for (const id of ['cover', 'park']) {
    const cellClass = library.cellClasses[id];
    if (cellClass) cellClass.params = { ...cellClass.params, perimeterWalls: true };
  }
  // Stage 2 draft: closed-side variants of the themed fill tiles take half their weight.
  for (const id of CLOSED_SIDE_TILES) {
    const tile = library.tiles.find((candidate) => candidate.id === id);
    if (tile) library.tiles.push(...closedSideVariants(tile, CLOSED_SIDE_SHARE));
  }
  return library;
}));

/** The matched counterpart of `bundledLibrary` (#849). */
export function matchedLibrary(params: Pick<ChainParams, 'zoneWidth' | 'zoneHeight' | 'mode'> = DEFAULT_CHAIN_PARAMS): ChainLibrary {
  const bundled = bundledLibrary(params);
  return MATCHED_LIBRARIES.find((library) => library.name === `${bundled.name}-matched`)!;
}

/** The bundled library for the default zone size, which live matches use. */
export const CHAIN_LIBRARY: ChainLibrary = CHAIN_LIBRARIES[0]!;

/**
 * The bundled library authored for a zone size. Game mode accepts only authored sizes;
 * playground mode accepts any, and takes the default library where none is authored (51).
 */
export function bundledLibrary(params: Pick<ChainParams, 'zoneWidth' | 'zoneHeight' | 'mode'> = DEFAULT_CHAIN_PARAMS): ChainLibrary {
  const authored = CHAIN_LIBRARIES.find((library) => library.zoneWidth === params.zoneWidth && library.zoneHeight === params.zoneHeight);
  if (authored) return authored;
  if ((params.mode ?? 'game') === 'playground') return CHAIN_LIBRARY;
  const sizes = CHAIN_LIBRARIES.map((library) => `${library.zoneWidth} x ${library.zoneHeight}`).join(', ');
  throw new Error(`no bundled library is authored for ${params.zoneWidth} x ${params.zoneHeight} tile zones; game mode takes ${sizes}`);
}

function assertParamsObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('params must be an object');
}

type NumericParam = Exclude<keyof ChainParams, 'mode'>;
const INTEGRAL: readonly NumericParam[] = ['zoneWidth', 'zoneHeight', 'exitCount', 'contestantCount', 'hunterCount'];
const FRACTIONAL: readonly NumericParam[] = ['lootChance', 'lootTierStep'];
/** Shorter names the CLI has always taken. */
const ALIASES: Record<string, NumericParam> = { exits: 'exitCount', contestants: 'contestantCount', hunters: 'hunterCount' };

/** Defaults with caller overrides, rejecting values placement cannot take. */
export function chainParams(input: object = {}): ChainParams {
  assertParamsObject(input);
  const params: ChainParams = { ...DEFAULT_CHAIN_PARAMS };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'mode') {
      if (value !== 'game' && value !== 'playground') throw new Error('params.mode must be game or playground');
      params.mode = value;
      continue;
    }
    const target = ALIASES[key] ?? (key as NumericParam);
    const integral = INTEGRAL.includes(target);
    if (!integral && !FRACTIONAL.includes(target)) throw new Error(`params.${key} is not a map param`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || (integral && !Number.isInteger(n)))
      throw new Error(`params.${key} must be ${integral ? 'a whole number' : 'a number'} of at least 0`);
    params[target] = n;
  }
  return params;
}

/**
 * The library checks, then, for a library under `matched` passability (17.2.2), its set pieces'
 * own seams: a rule or tile change can leave a set piece that was valid when saved unplaceable.
 */
export function validateLibrary(library: unknown): LibraryValidation {
  const checked = validateChainLibrary(library, GAME_REGION_TYPES);
  if (!checked.valid) return checked;
  const seams = setPieceSeamProblems(library as ChainLibrary);
  return seams.length ? { valid: false, errors: seams } : checked;
}

export function checkedLibrary(library: unknown = CHAIN_LIBRARY): ChainLibrary {
  const checked = validateLibrary(library);
  if (!checked.valid) throw new Error(`invalid library: ${checked.errors.join('; ')}`);
  return library as ChainLibrary;
}

export function seedText(seed: unknown): string {
  if (typeof seed !== 'string' && typeof seed !== 'number') throw new Error('seed must be a string or number');
  return String(seed);
}

/**
 * A map from the generation chain, placed by macro and built with the game's
 * region strategies. Uses the bundled library for its zone size unless supplied another.
 */
export function generate(seed: unknown, params: object = {}, library?: unknown, cellSize = DEFAULT_CELL_SIZE): GameChainMap {
  if (!isCellSize(cellSize)) throw new Error('cell size must be a positive whole number of world units');
  const resolved = chainParams(params);
  return generateChainMap(seedText(seed), resolved, checkedLibrary(library ?? bundledLibrary(resolved)), cellSize, GAME_ENGINES);
}

/**
 * Macro's layer of `generate` alone (#821): the same Layout, with no region built. Its views
 * through the briefs are those `generate` gives for the same arguments; it has no built map or
 * report. A test of macro, or of what macro hands a builder, reads it without paying for the builds.
 */
export function generateMacro(seed: unknown, params: object = {}, library?: unknown, cellSize = DEFAULT_CELL_SIZE): GameChainMap {
  if (!isCellSize(cellSize)) throw new Error('cell size must be a positive whole number of world units');
  const resolved = chainParams(params), checked = checkedLibrary(library ?? bundledLibrary(resolved));
  return { layout: placement(seedText(seed), resolved, checked), library: checked, cellSize, build: GAME_ENGINES.version, results: [] };
}
