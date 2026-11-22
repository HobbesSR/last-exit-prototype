import { tickFinish } from './tick-finish.ts';
import { collectBotIntent } from './bots.ts';
import { beginDynamicNavigationCollection, endDynamicNavigationCollection } from './dynamic-navigation.ts';
import type { BotIntent } from './bots.ts';
import { consumeInput } from './input.ts';
import { tickBegin } from './tick-begin.ts';
import { phaseSix, STEP_CHARGING, STEP_INTERACT, STEP_PICKUPS, STEP_TRANSIT } from './phase-six.ts';
import type { Turn } from './phase-six.ts';
import { environmentAndTraps } from './hazards.ts';
import { advanceDiscovery } from './tick-rules.ts';
import { playerIndex } from './relations.ts';
import { finishMatch, recordRewind } from './phase-seven.ts';
import { ordered, synchronize } from './game.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { PhysicsRuntime } from './physics-runtime.ts';
import type { Game } from '../types.ts';
import { start, stop } from '../profiler.ts';

/** The seven-phase tick. Actors move only through the physics world, never `movePlayer`. */
export function stepGame(s: Game): void {
  const r = physicsRuntime(s);
  if (!r) throw new Error('physics world missing or disposed');
  if (s.phase !== 'live') return;
  r.stepping = true;
  start('sim.step');
  try { advanceGame(s, r); } finally { r.stepping = false; stop('sim.step'); }
}

// Timed by phase (sim.*; 42.22). Every synchronize call is counted in sim.sync.
function advanceGame(s: Game, r: PhysicsRuntime): void {
  // 1: all timers and previous-boundary lifecycle, before anyone decides: the tick, timers, respawn and arrival
  // (phase-one.ts), then the body sync and the pending admission (boundary.ts), all in the core; the hooks here.
  // One core call (D4's `tick_begin`, #1214 stage 6e.5): the markers' trim, the sync, the hooks, the spawns, the
  // pending admission and the commit follow phase 1 there, and each is applied here in that order.
  start('sim.begin'); tickBegin(s, r); stop('sim.begin');
  // 2: roster-order collection from the same pre-movement world.
  const intents = new Array<BotIntent | undefined>(s.players.length);
  start('sim.bots');
  start('sim.bots.collect'); beginDynamicNavigationCollection(s); stop('sim.bots.collect');
  try {
    for (let idx = 0; idx < s.players.length; idx++) {
      const p = s.players[idx];
      if (p.status === 'active') intents[idx] = p.bot ? collectBotIntent(s, p) : { input: consumeInput(p, s.tick) };
    }
  } finally { endDynamicNavigationCollection(s); stop('sim.bots'); }
  // 3 to 5 in one core call (D4's `tick_finish`, #1214 stage 6e.5b), built there from the intents.
  start('sim.finish'); tickFinish(s, r, intents); stop('sim.finish');
  // 6: interactions/pickups, environment, traps; trap spawns wait for next tick.
  start('sim.pickups');
  // The per-actor loop runs in the core (`phase_six.rs`, 27 step 5e.1): interact, the chosen transit, then, while
  // still active, charging and pickups. Movement below the reviewed resting-contact tolerance is jitter, not a move.
  const turns: Turn[] = [];
  for (const p of ordered(s)) {
    const input = intents[playerIndex(s, p)]?.input;
    if (p.status !== 'active' || !input) continue;
    const transit = !!input.transit && s.content.transit === 'selectable';
    turns.push({ player: p, steps: (input.interact ? STEP_INTERACT : 0) | (transit ? STEP_TRANSIT : 0) | STEP_CHARGING | STEP_PICKUPS,
      choice: transit ? input.transit : undefined, sneak: !!input.sneak, moved: (p.movedThisTick ?? 0) > 0.05 });
  }
  phaseSix(s, turns, true);
  stop('sim.pickups');
  // The environment, then the traps, in the core (`hazards.rs`, 27 step 5e.2); a turret's spawns wait in `pendingSpawns`.
  start('sim.environment');
  environmentAndTraps(s);
  stop('sim.environment');
  if (r.pendingSpawns.length > 128) throw new RangeError('pending projectile capacity');
  // 7: next-boundary body state, discovery, terminal result, rewind and capture readiness. The terminal result and the
  // rewind frame are the core's (`phase_seven.rs`, 27 step 5e.2), as the syncs and discovery are.
  start('sim.sync'); synchronize(s, r, s.tick); stop('sim.sync');
  advanceDiscovery(s);
  finishMatch(s);
  start('sim.sync'); synchronize(s, r, s.tick); stop('sim.sync');
  start('sim.rewind'); recordRewind(s); stop('sim.rewind');
}
