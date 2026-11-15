/** The game's entry point for the generation chain (51): macro placement through micro construction. */
import { validateLibrary as validateChainLibrary } from './macro/src/chain/library.ts';
import type { ChainLibrary, LibraryValidation } from './macro/src/chain/library.ts';
import { generateChainMap } from './macro/src/chain/map.ts';
import { placement, setPieceSeamProblems } from './macro/src/chain/placement.ts';
import type { ChainMap } from './macro/src/chain/types.ts';
import type { RegionElement } from './micro/types.ts';
import { DEFAULT_CELL_SIZE, GAME_ENGINES, GAME_REGION_TYPES } from './engines.ts';
import { isCellSize } from './kernel/scale.ts';
import { CHAIN_LIBRARY, bundledLibrary } from './macro/src/chain/bundled-library.ts';
import { chainParams } from './macro/src/chain/params.ts';
export { CHAIN_LIBRARIES, CHAIN_LIBRARY, bundledLibrary } from './macro/src/chain/bundled-library.ts';
export { chainParams } from './macro/src/chain/params.ts';

export type GameChainMap = ChainMap<RegionElement>;

/**
 * The library checks, then its set pieces' own seams under matched passability (17.2.2): a rule or tile change can leave a set piece that was valid when saved unplaceable.
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
