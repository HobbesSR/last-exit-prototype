import { CONTAINER_ROW } from './container-row.ts';
import { COVER_PIECE } from './cover-piece.ts';
import { HOUSE } from './house.ts';
import { WAREHOUSE } from './warehouse.ts';
import { placeableErrors } from './placeable.ts';
import type { Placeable, Placed, Refusal } from './placeable.ts';

/**
 * Every placeable (20.8), by id. The list is explicit rather than filled by imports registering
 * themselves, so its order never hangs on import order. Adding one: a module in this folder with
 * a header comment, an entry here, and its version in `tests/micro-placeables.test.js`.
 */
export const PLACEABLES: Readonly<Record<string, Placeable<any, unknown>>> = Object.freeze({
  [WAREHOUSE.id]: WAREHOUSE,
  [CONTAINER_ROW.id]: CONTAINER_ROW,
  [HOUSE.id]: HOUSE,
  [COVER_PIECE.id]: COVER_PIECE,
});

/**
 * Build a placeable by id from unchecked parameters, as a tool or agent would. Strategies call
 * the descriptor itself, with typed parameters. Unknown ids and invalid parameters throw.
 */
export function buildPlaceable(id: string, params: unknown, cellSize: number): Placed<unknown> | Refusal {
  if (!Object.hasOwn(PLACEABLES, id)) throw new Error(`Unknown placeable ${id}.`);
  const placeable = PLACEABLES[id]!, errors = placeableErrors(placeable, params);
  if (errors.length) throw new RangeError(errors.join(' '));
  return placeable.build(params, cellSize);
}
