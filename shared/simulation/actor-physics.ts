import { bodyRadius } from '../movement.ts';
import type { ActorPhysics, Game, GameMap, MotorSurface, Player, Vec2 } from '../types.ts';

export const PHYSICS_CHARACTER_VERSION = 'last-exit-0.8-physics-2';
export const actorRadius = (s: Game, p: Player): number => s.content.actorPhysics?.geometry[p.role].bodyRadius ?? bodyRadius(p);

/** Reject malformed experimental tuning before allocating a world. Without a profile, motor surfaces are unread. */
export function validateActorPhysics(profile: ActorPhysics | undefined, map: GameMap): void {
  if (!profile) return;
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
export function characterMotor(profile: Pick<ActorPhysics, 'acceleration' | 'braking'> | undefined,
  surfaces: MotorSurface[] | undefined, p: Vec2, x: number, y: number, speed: number): { x: number; y: number; accel: number } {
  const length = Math.max(1, Math.hypot(x, y));
  const surface = profile ? surfaces?.filter(f => p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h)
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0] : undefined;
  const moving = x !== 0 || y !== 0;
  const accel = moving ? (profile?.acceleration ?? 3600) * (surface?.traction ?? 1) : (profile?.braking ?? 3600) * (surface?.braking ?? 1);
  return { x: x / length * speed * (surface?.speed ?? 1), y: y / length * speed * (surface?.speed ?? 1), accel };
}
