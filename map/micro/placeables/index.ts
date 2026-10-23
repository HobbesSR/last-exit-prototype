import { CONTAINER_ROW } from './container-row.ts';
import { COVER_PIECE } from './cover-piece.ts';
import { HOUSE } from './house.ts';
import { WALL_RUN } from './wall-run.ts';
import { WAREHOUSE } from './warehouse.ts';
import { COMPOUND_RING } from './compound-ring.ts';
import { CHECKPOINT_BARRIER } from './checkpoint-barrier.ts';
import { EXAMPLE_ROOM_SHELL } from './example-room-shell.ts';
import { FALLEN_SLAB } from './fallen-slab.ts';
import { HALL_PILLAR } from './hall-pillar.ts';
import { RUIN_ROOM_SPAN } from './ruin-room-span.ts';
import { RUBBLE_DEBRIS } from './rubble-debris.ts';
import { PARK_TREE } from './park-tree.ts';
import { PARK_HEDGE_RUN } from './park-hedge-run.ts';
import { PLANT_MACHINE } from './plant-machine.ts';
import { PLANT_PIPE_RUN } from './plant-pipe-run.ts';
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
  [WALL_RUN.id]: WALL_RUN,
  [COMPOUND_RING.id]: COMPOUND_RING,
  [CHECKPOINT_BARRIER.id]: CHECKPOINT_BARRIER,
  [EXAMPLE_ROOM_SHELL.id]: EXAMPLE_ROOM_SHELL,
  [FALLEN_SLAB.id]: FALLEN_SLAB,
  [HALL_PILLAR.id]: HALL_PILLAR,
  [RUIN_ROOM_SPAN.id]: RUIN_ROOM_SPAN,
  [RUBBLE_DEBRIS.id]: RUBBLE_DEBRIS,
  [PARK_TREE.id]: PARK_TREE,
  [PARK_HEDGE_RUN.id]: PARK_HEDGE_RUN,
  [PLANT_MACHINE.id]: PLANT_MACHINE,
  [PLANT_PIPE_RUN.id]: PLANT_PIPE_RUN,
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
