// Shared rules; each coordinator owns when and in which actor order they run.
import { DISCOVERY_INTERVAL, discover } from '../discovery.ts';
import { start, stop } from '../profiler.ts';
import { damage } from './combat.ts';
import { sightOf } from './sight-runtime.ts';
import type { Game, Player } from '../types.ts';

// The tick, the hazard wall, effect lives and the countdown timers advance in the core's phase 1
// (`rust/core/src/phase_one.rs`).

export function applyEnvironment(s: Game, p: Player): void {
  if (p.x < s.hazardX && s.tick % 5 === 0) damage(s, p, 9, null);
  if (s.tick % 12 === 0 && s.map.hazards.some(h => p.x > h.x && p.x < h.x + h.w && p.y > h.y && p.y < h.y + h.h)) damage(s, p, 5, null);
}

export function advanceDiscovery(s: Game): void {
  if (!s.content.discovery) return;
  start('sim.discovery');
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i]!;
    if (p.role === 'contestant' && p.discovery && p.status === 'active' && (s.tick + i) % DISCOVERY_INTERVAL === 0) {
      discover(sightOf(s), p.discovery, s.map, p, undefined, p.bot, s.items);
    }
  }
  stop('sim.discovery');
}
