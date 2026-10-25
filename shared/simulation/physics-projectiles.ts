import { actorHitRadius, closedGateShapes, firstContact, impact, staticShapes } from './swept.ts';
import { damage } from './combat.ts';
import type { Game, Player, Projectile, Vec2 } from '../types.ts';

const PROJECTILE_RADIUS = 2;

/** One swept owner for fast query projectiles; never also run legacy advanceProjectiles. */
export function solvePhysicsProjectiles(s: Game, paths: Record<string, Vec2[]>): void {
  const hits: { bullet: Projectile; target: Player; toi: number }[] = [];
  const expired = new Set<Projectile>();
  const shapes = [...staticShapes(s.map, true), ...closedGateShapes(s.map.gates)];
  for (const bullet of s.projectiles) {
    const origin = { x: bullet.x, y: bullet.y };
    const end = { x: bullet.x + bullet.dx, y: bullet.y + bullet.dy };
    bullet.life--;
    if (bullet.life <= 0) { expired.add(bullet); continue; }
    const blockedAt = firstContact(origin, end, shapes, PROJECTILE_RADIUS);
    if (blockedAt < Infinity) expired.add(bullet);
    for (const target of s.players) {
      if (target.id === bullet.owner || target.status !== 'active') continue;
      const path = paths[`actor:${target.id}`] ?? Array.from({ length: 5 }, () => ({ x: target.x, y: target.y }));
      for (let k = 0; k < 4; k++) {
        const a = { x: origin.x + bullet.dx * k / 4, y: origin.y + bullet.dy * k / 4 };
        const b = { x: origin.x + bullet.dx * (k + 1) / 4, y: origin.y + bullet.dy * (k + 1) / 4 };
        const t = impact(a, b, path[k]!, path[k + 1]!, actorHitRadius(target.role));
        if (t === null) continue;
        const toi = (k + t) / 4;
        if (toi < blockedAt) hits.push({ bullet, target, toi });
        break;
      }
    }
    bullet.x = end.x; bullet.y = end.y;
  }
  const consumed = new Set<Projectile>();
  hits.sort((a, b) => a.toi - b.toi || a.bullet.id - b.bullet.id || compare(a.target.id, b.target.id));
  for (const { bullet, target } of hits) {
    if (consumed.has(bullet) || target.status !== 'active') continue;
    consumed.add(bullet);
    damage(s, target, bullet.damage, s.players.find(p => p.id === bullet.owner) ?? null);
  }
  s.projectiles = s.projectiles.filter(b => !consumed.has(b) && !expired.has(b));
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
