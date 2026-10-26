import { lineClear } from '../movement.ts';
import type { Game, Vec2 } from '../types.ts';
import { enqueuePhysicsImpulse, physicsRuntime } from './physics-runtime.ts';
import { hypot } from '../math.ts';

/** Queue the physical part of a mine blast for the next physics tick. */
export function enqueueExplosionImpulses(s: Game, origin: Vec2, radius: number): void {
  const tuning = s.content.worldPhysics;
  const runtime = physicsRuntime(s);
  if (!tuning || !runtime || !(radius > 0)) return;

  // Capture current solved poses once. The static map remains the mine's cover authority;
  // dynamic props are deliberately inert blast cover in this slice.
  runtime.synchronize();
  const bodies = runtime.world.snapshot({ includeStatic: false }).bodies
    .filter(body => body.spec.kind !== 'static')
    .sort((a, b) => a.spec.id < b.spec.id ? -1 : a.spec.id > b.spec.id ? 1 : 0);
  for (const body of bodies) {
    const dx = body.transform.x - origin.x, dy = body.transform.y - origin.y;
    const distance = hypot(dx, dy);
    if (distance >= radius || !lineClear(s.map, origin, body.transform)) continue;
    const magnitude = tuning.maxImpulse * (1 - distance / radius);
    if (!(magnitude > 0)) continue;
    const direction = distance === 0 ? { x: 1, y: 0 } : { x: dx / distance, y: dy / distance };
    enqueuePhysicsImpulse(s, body.spec.id, { x: direction.x * magnitude, y: direction.y * magnitude });
  }
}
