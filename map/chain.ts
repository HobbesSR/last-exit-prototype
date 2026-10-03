/** The game's map-level entry point for macro placement and micro construction. */
import chainLibrary from './macro/content/chain-library.json' with { type: 'json' };
import { validateLibrary as validateChainLibrary } from './macro/src/chain/library.ts';
import type { ChainLibrary, LibraryValidation } from './macro/src/chain/library.ts';
import { generateChainMap } from './macro/src/chain/map.ts';
import { DEFAULT_CHAIN_PARAMS } from './macro/src/chain/placement.ts';
import type { ChainMap, ChainParams } from './macro/src/chain/types.ts';
import type { RegionElement } from './micro/types.ts';
import { DEFAULT_CELL_SIZE, GAME_ENGINES, GAME_REGION_TYPES } from './engines.ts';

export type GameChainMap = ChainMap<RegionElement>;

/** The bundled chain library used unless a caller supplies another. */
export const CHAIN_LIBRARY: ChainLibrary = chainLibrary as ChainLibrary;

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

/** A chain map placed by macro and built with the game's region strategies. */
export function generate(seed: unknown, params: object = {}, library?: unknown, cellSize = DEFAULT_CELL_SIZE): GameChainMap {
  if (!(cellSize > 0)) throw new Error('cell size must be a positive number');
  return generateChainMap(seedText(seed), chainParams(params), checkedLibrary(library), cellSize, GAME_ENGINES);
}
