import { event } from './event-records.ts';
import type { Game, Player } from '../types.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { eliminateInCore } from './phase-three.ts';

/**
 * `eliminate` runs in the core (`actions_run`'s mode 4 in `rust/core/src/phase_three.rs`, #1242, docs/27 step 5d.2): the
 * lifecycle, each mandatory drop at its own sync boundary, the reserves and the kill credit. Damage reaches it through
 * phase 5's run; this is its entry for scenarios, and needs the game's physics world.
 */
export function eliminate(s: Game, target: Player, source: Player | null): void {
  if (!physicsRuntime(s)) throw new Error("elimination runs in the core and needs the game's physics world");
  eliminateInCore(s, target, source);
}
// Respawn runs in the core's phase 1 (`rust/core/src/phase_one.rs`, adapter `phase-one.ts`).
export function finishMatch(s: Game): void {
  if (s.slots === 0 || !s.players.some(p => p.role === 'contestant' && p.status === 'active') || s.tick >= s.content.durationTicks) {
    s.phase = 'finished'; for (const p of s.players) if (p.role === 'contestant' && p.status === 'active') p.status = 'stranded'; event(s, { kind: 'match_finished' });
  }
}
