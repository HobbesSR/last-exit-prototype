import { phaseSix, STEP_INTERACT } from './phase-six.ts';
import type { Game, Player } from '../types.ts';

// `interact` runs in the core (`rust/core/src/phase_six.rs`, #1230, docs/27 "The state flip", step 5e.1), with the swap's
// staged pickup and drop: extraction, the swap, gates and a gladiator's transit. The tick runs it in phase 6's loop
// (`phaseSix`); this is its entry for the two scenario tests that arrange a gate or a transit on an unstarted game
// (`tests/physics-character.test.js`, `tests/shared-rules.test.js`), and needs the game's physics world.

export function interact(s: Game, p: Player): void {
  phaseSix(s, [{ player: p, steps: STEP_INTERACT }], false);
}
