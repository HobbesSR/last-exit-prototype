import { bodyRadius, canOccupy } from '../movement.ts';
import { clearRoute } from './geometry.ts';
import { actorRadius } from './actor-physics.ts';
import { physicsRuntime } from './physics-runtime.ts';
import type { Game, PlayerId, Vec2 } from '../types.ts';

/**
 * Development commands (24): what the dev view may do to a match that play cannot. None runs unless a
 * dev session asks, so ordinary matches and the frozen fixture never meet them.
 */

/**
 * Put an active player's body at a point, between ticks. Refuses a point that body could not stand on,
 * by the same occupancy rule movement uses, and returns where it landed. A bot's route is dropped so
 * it plans again from there; nothing else about the player changes.
 */
export function teleport(s: Game, id: PlayerId, x: number, y: number): Vec2 | null {
  const p = s.players.find(p => p.id === id);
  if (!p || p.status !== 'active' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const at = { x: Math.round(x), y: Math.round(y) };
  const runtime = physicsRuntime(s);
  const radius = runtime ? actorRadius(s, p) : bodyRadius(p);
  if (!canOccupy(s.map, at.x, at.y, radius)) return null;
  if (runtime && s.content.actorPhysics && (runtime.world.overlapsProp(at.x, at.y, radius)
    || s.players.some(q => q !== p && q.status === 'active' && Math.hypot(at.x - q.x, at.y - q.y) < radius + actorRadius(s, q)))) return null;
  p.x = at.x; p.y = at.y; clearRoute(p);
  runtime?.synchronize();
  return at;
}
