import { physicsRuntime } from './physics-runtime.ts';
import { attackInCore } from './phase-three.ts';
import { castersInCore } from './phase-five.ts';
import type { Game, Player } from '../types.ts';

// Combat is the core's (`rust/core/src/combat.rs`, `action_combat.rs`, the tick's phases 3 and 5). What is left here is
// one scenario entry into it on an unstarted game, which `tests/hearing.test.js` presses; it goes when those cases fire
// through a command on a started game (27.2 "Test API", #1358).

/** An attack outside the tick, for scenarios: a gladiator's as phase 5's caster run, a contestant's as phase 3's. */
export function attack(s: Game, p: Player): void {
  if (!physicsRuntime(s)) throw new Error("attack runs in the core and needs the game's physics world");
  if (p.role === 'gladiator') castersInCore(s, [{ player: p, skill: false, attack: true }]);
  else attackInCore(s, p);
}
