// Public compatibility surface and the fixed-tick entry point. The tick itself is `simulation/tick.ts`.
export { TILE } from './movement.ts';
export { VERSION, HZ, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS, KITS } from './simulation/rules.ts';
export { createGameRecord, joinGame, setInput } from './simulation/state.ts';
export { POTENTIAL, couldSee, visibleTo, playerView, snapshot } from './simulation/visibility.ts';
import type { Game } from './types.ts';
import { PHYSICS_VERSION } from './simulation/physics-runtime.ts';
import { stepGame } from './simulation/tick.ts';
export { createGame, synchronizePhysics } from './simulation/game.ts';
export { disposePhysics, enqueuePhysicsImpulse, enqueuePhysicsAttachment, PHYSICS_VERSION } from './simulation/physics-runtime.ts';

/**
 * Advance a match one tick. Only a physics game steps: `createGameRecord` builds the record a game
 * starts from, and the legacy mover that once stepped it on its own is retired (#920).
 */
export function step(s: Game): void {
  if (s.version !== PHYSICS_VERSION) throw new RangeError('only a game built with createGame steps');
  stepGame(s);
}
