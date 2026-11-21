import { phaseSix, STEP_CHARGING, STEP_INTERACT } from './phase-six.ts';
import type { Game, Player, PlayerInput } from '../types.ts';

// `interact` and `advanceCharging` run in the core (`rust/core/src/phase_six.rs`, #1230, docs/27 "The state flip",
// step 5e.1), with the swap's staged pickup and drop: extraction, charging, the swap, gates and a gladiator's transit.
// The tick runs them in phase 6's loop (`phaseSix`); these are their entries for scenarios, and need the game's
// physics world.

export function interact(s: Game, p: Player): void {
  phaseSix(s, [{ player: p, steps: STEP_INTERACT }], false);
}
export function advanceCharging(s: Game, p: Player, input: PlayerInput): void {
  phaseSix(s, [{ player: p, steps: STEP_CHARGING, moved: !!(input.x || input.y) }], false);
}
