import { canOccupy } from '../movement.ts';
import { reachClear } from '../sight.ts';
import { scatterInCore } from './boundary.ts';
import { physicsRuntime } from './physics-runtime.ts';
import { itemsNear } from './ground-items.ts';
import { distance } from './geometry.ts';
import type { Game, Vec2 } from '../types.ts';
import { cos, sin } from '../math.ts';

/**
 * The bounded L0 spiral search: a free, reachable point near `origin`, clear of both lists. A game with a physics world
 * asks the core (`scatterInCore`, #1228), which also keeps the spot clear for a loot body, as the body sync admits
 * one. A record without one (match setup's `seedAmmo`, before `createGame` attaches the world) searches here, where
 * no body needs room. `tests/drop-scatter-core.test.js` holds the core equal to this spiral with that test added.
 */
export function scatterPoint(s: Game, origin: Vec2, phase: number, items: readonly Vec2[], points: readonly Vec2[] = []): Vec2 | undefined {
  const runtime = physicsRuntime(s);
  if (runtime) return scatterInCore(s, runtime, origin, phase, items, points);
  for (let j = 0; j < 180; j++) {
    const angle = (phase + j) * 2.39996, radius = 36 + Math.floor(j / 12) * 24;
    const candidate = { x: origin.x + cos(angle) * radius, y: origin.y + sin(angle) * radius };
    if (canOccupy(s.map, candidate.x, candidate.y, 16) && reachClear(s.map, origin, candidate)
      && (items === s.items ? itemsNear(s, candidate, 32) : items).every(other => distance(other, candidate) > 32)
      && points.every(other => distance(other, candidate) > 32)) return candidate;
  }
  return undefined;
}

/** A drop, fully represented but not yet committed. */
export type { DropPlan } from './action-records.ts';

