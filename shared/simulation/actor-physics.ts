import { bodyRadius } from '../movement.ts';
import type { ActorPhysics, Game, GameMap, MotorSurface, Player, Vec2 } from '../types.ts';
import { hypot } from '../math.ts';

export const actorRadius = (s: Game, p: Player): number => s.content.actorPhysics.geometry[p.role].bodyRadius;

/** Reject malformed tuning before allocating a world. */
export function validateActorPhysics(profile: ActorPhysics, map: GameMap): void {
  if (!profile || typeof profile !== 'object' || !profile.geometry?.contestant || !profile.geometry?.gladiator)
    throw new RangeError('invalid actor physics profile');
  for (const role of ['contestant', 'gladiator'] as const) {
    const g = profile.geometry[role];
    if (![g.bodyRadius, g.headRadius, g.hurtRadius, profile.acceleration, profile.braking, profile.maxImpulse, profile.maxSpeed]
      .every(n => Number.isFinite(n) && n > 0 && n <= 100000)) throw new RangeError('invalid actor physics profile');
    if (g.bodyRadius >= g.headRadius || g.hurtRadius !== bodyRadius({ role }))
      throw new RangeError('narrow body and unchanged combat hurt radius required');
  }
  const ids = new Set<string>();
  if ((map.motorSurfaces?.length ?? 0) > 1024) throw new RangeError('motor surface capacity');
  for (const surface of map.motorSurfaces ?? []) {
    if (!surface.id || ids.has(surface.id) || ![surface.x, surface.y, surface.w, surface.h, surface.priority].every(Number.isFinite)
      || surface.w <= 0 || surface.h <= 0 || ![surface.speed, surface.traction, surface.braking].every(n => Number.isFinite(n) && n >= 0 && n <= 1))
      throw new RangeError('invalid motor surface');
    ids.add(surface.id);
  }
}

export function actorMotor(s: Game, p: Player, x: number, y: number, speed: number): { x: number; y: number; accel: number } {
  return characterMotor(s.content.actorPhysics, s.map.motorSurfaces, p, x, y, speed);
}

/** Shared motor calculation for the authoritative solver and local prediction. */
export function characterMotor(profile: Pick<ActorPhysics, 'acceleration' | 'braking'>,
  surfaces: MotorSurface[] | undefined, p: Vec2, x: number, y: number, speed: number): { x: number; y: number; accel: number } {
  const length = Math.max(1, hypot(x, y));
  const surface = surfaces?.filter(f => p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h)
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  const moving = x !== 0 || y !== 0;
  const accel = moving ? profile.acceleration * (surface?.traction ?? 1)
    : profile.braking * (surface?.braking ?? 1);
  return { x: x / length * speed * (surface?.speed ?? 1), y: y / length * speed * (surface?.speed ?? 1), accel };
}
