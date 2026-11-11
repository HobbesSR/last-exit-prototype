// Public compatibility surface and the fixed-tick entry point. The tick itself is `simulation/phased.ts`.
export { TILE } from './movement.ts';
export { VERSION, HZ, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS, KITS } from './simulation/rules.ts';
export { createGame, joinGame, setInput } from './simulation/state.ts';
export { POTENTIAL, couldSee, visibleTo, playerView, snapshot } from './simulation/visibility.ts';
import type { Game } from './types.ts';
import { PHYSICS_VERSION } from './simulation/physics-runtime.ts';
import { stepPhysics } from './simulation/phased.ts';
export { createPhysicsGame, synchronizePhysics } from './simulation/phased.ts';
export { disposePhysics, enqueuePhysicsImpulse, enqueuePhysicsAttachment, PHYSICS_VERSION } from './simulation/physics-runtime.ts';

/**
 * Advance a match one tick. Only a physics game steps: `createGame` builds the record a physics game
 * starts from, and the legacy mover that once stepped it on its own is retired (#920).
 */
export function step(s: Game): void {
  if (s.version !== PHYSICS_VERSION) throw new RangeError('only a physics game steps; build it with createPhysicsGame');
  stepPhysics(s);
}
