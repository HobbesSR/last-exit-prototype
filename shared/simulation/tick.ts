import { tickFinish } from './tick-finish.ts';
import { collectBotIntent } from './bots.ts';
import { beginDynamicNavigationCollection, endDynamicNavigationCollection } from './dynamic-navigation.ts';
import type { BotIntent } from './bots.ts';
import { consumeInput } from './input.ts';
import { tickBegin } from './tick-begin.ts';
import { advanceDiscovery } from './tick-rules.ts';
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
  // 3 to 7 in one core call (D4's `tick_finish`, #1214 stages 6e.5b and 6e.5c), built there from the intents.
  start('sim.finish'); tickFinish(s, r, intents); stop('sim.finish');
  // 7's discovery is Node's, after the call: each contestant's memory, from the mirror as the call left it.
  advanceDiscovery(s);
}
