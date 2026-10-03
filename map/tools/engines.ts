/**
 * The one place the tools join the two halves (51 step 10, #144). Macro and micro don't
 * import each other (50), so macro's chain takes the game's strategies as `MapEngines`,
 * and the tools, which show both halves, assemble them here.
 */
import type { RegionBrief } from '../kernel/contract.ts';
import type { MapEngines } from '../macro/src/chain/types.ts';
import { composeRegions } from '../micro/compose.ts';
import { buildRegion, REGION_TYPES, REGION_TYPES_VERSION } from '../micro/region-types.ts';
import type { RegionElement } from '../micro/types.ts';

/** The game's registry, lent to macro: its version names the strategies a save was built with. */
export const GAME_ENGINES: MapEngines<RegionElement> = Object.freeze({
  version: REGION_TYPES_VERSION,
  // Wrapped, so macro's single argument never reaches the registry parameter.
  build: (brief: RegionBrief) => buildRegion(brief),
  compose: composeRegions,
});

/** The region types a library's classes may bind to (`validateLibrary`'s second argument). */
export const GAME_REGION_TYPES: ReadonlySet<string> = new Set(Object.keys(REGION_TYPES));

/**
 * The briefs' cell size in world units. The live game doesn't play chain maps yet (41), so
 * nothing fixes the scale; this is the size the chain's tests build at. A saved map records
 * its own.
 */
export const DEFAULT_CELL_SIZE = 48;
