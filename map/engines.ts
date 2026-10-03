/** The game's region strategies supplied to macro's generic chain. */
import type { RegionBrief } from './kernel/contract.ts';
import type { MapEngines } from './macro/src/chain/types.ts';
import { composeRegions } from './micro/compose.ts';
import { buildRegion, REGION_TYPES, REGION_TYPES_VERSION } from './micro/region-types.ts';
import type { RegionElement } from './micro/types.ts';

/** The version names the strategies used to build a saved map. */
export const GAME_ENGINES: MapEngines<RegionElement> = Object.freeze({
  version: REGION_TYPES_VERSION,
  // Wrapped, so macro's single argument never reaches the registry parameter.
  build: (brief: RegionBrief) => buildRegion(brief),
  compose: composeRegions,
});

/** Region types to which library classes may bind. */
export const GAME_REGION_TYPES: ReadonlySet<string> = new Set(Object.keys(REGION_TYPES));

/** Default brief cell size in world units. */
export const DEFAULT_CELL_SIZE = 48;
