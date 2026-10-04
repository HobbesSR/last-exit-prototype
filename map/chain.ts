/** The game's map-level entry point for macro placement and micro construction. */
import diamond12x6 from './macro/content/diamond-12x6.json' with { type: 'json' };
import diamond24x12 from './macro/content/diamond-24x12.json' with { type: 'json' };
import diamond36x18 from './macro/content/diamond-36x18.json' with { type: 'json' };
import commonPrimitives from './macro/content/common-primitives@2.json' with { type: 'json' };
import commonSetPieces from './macro/content/common-set-pieces@2.json' with { type: 'json' };
import districtSetPieces from './macro/content/district-set-pieces@1.json' with { type: 'json' };
import { resolveLibrary, validateLibrary as validateChainLibrary } from './macro/src/chain/library.ts';
import type { ChainLibrary, LibraryValidation } from './macro/src/chain/library.ts';
import { generateChainMap } from './macro/src/chain/map.ts';
import { DEFAULT_CHAIN_PARAMS } from './macro/src/chain/placement.ts';
import type { ChainMap, ChainParams } from './macro/src/chain/types.ts';
import type { RegionElement } from './micro/types.ts';
import { DEFAULT_CELL_SIZE, GAME_ENGINES, GAME_REGION_TYPES } from './engines.ts';

export type GameChainMap = ChainMap<RegionElement>;

const MODULES = {
  'common-primitives@2': commonPrimitives, 'common-set-pieces@2': commonSetPieces,
  'district-set-pieces@1': districtSetPieces,
};

/** The bundled libraries, one per zone size the diamond is authored for (55), default first. */
export const CHAIN_LIBRARIES: readonly ChainLibrary[] = Object.freeze(
  [diamond12x6, diamond24x12, diamond36x18].map((top) => resolveLibrary(top, MODULES)));

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

export function validateLibrary(library: unknown): LibraryValidation {
  return validateChainLibrary(library, GAME_REGION_TYPES);
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
 * A chain map placed by macro and built with the game's region strategies, from the
 * bundled library for its zone size unless the caller supplies another.
 */
export function generate(seed: unknown, params: object = {}, library?: unknown, cellSize = DEFAULT_CELL_SIZE): GameChainMap {
  if (!(cellSize > 0)) throw new Error('cell size must be a positive number');
  const resolved = chainParams(params);
  return generateChainMap(seedText(seed), resolved, checkedLibrary(library ?? bundledLibrary(resolved)), cellSize, GAME_ENGINES);
}
