/** Authored chain libraries, resolved from macro's bundled content modules (51.2). */
import diamond12x6 from '../../content/diamond-12x6.json' with { type: 'json' };
import diamond24x12 from '../../content/diamond-24x12.json' with { type: 'json' };
import diamond36x18 from '../../content/diamond-36x18.json' with { type: 'json' };
import commonPrimitives from '../../content/common-primitives@7.json' with { type: 'json' };
import commonSetPieces from '../../content/common-set-pieces@7.json' with { type: 'json' };
import districtSetPieces from '../../content/district-set-pieces@6.json' with { type: 'json' };
import { resolveLibrary } from './library.ts';
import type { ChainLibrary } from './library.ts';
import { DEFAULT_CHAIN_PARAMS } from './placement.ts';
import type { ChainParams } from './types.ts';

const MODULES = {
  'common-primitives@7': commonPrimitives, 'common-set-pieces@7': commonSetPieces,
  'district-set-pieces@6': districtSetPieces,
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
