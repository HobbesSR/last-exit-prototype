import { canOccupy, lineClear } from './movement.ts';
import { distance } from './vector.ts';
import type { EffectKind, Game, Player, PlayerId, Vec2, World } from './types.ts';

// Injected rather than imported, so hazards stay a leaf: traps never reach back into combat.
export type DamageFn = (s: Game, target: Player, amount: number, source: Player | null) => void;
export type EffectFn = (s: Game, at: Vec2, kind: EffectKind, radius?: World) => void;

export function stepTraps(s: Game, damage: DamageFn, effect: EffectFn): void {
  for (const trap of s.map.traps || []) {
    if (trap.spent) continue;
    trap.cooldown = Math.max(0, (trap.cooldown || 0) - 1);
    const active = s.players.filter(p => p.status === 'active');
    if (trap.kind === 'mine') {
      const mine = s.content.traps.mine;
      // The blast radius is also the ring that gets drawn: a mine damaging past what it showed would
      // be reading as a lie, so the two are one number rather than two that happen to agree.
      if (!active.some(p => distance(p, trap) < mine.trigger && (p.movedThisTick ?? 0) > 0.5 && lineClear(s.map, trap, p))) continue;
      trap.spent = true; effect(s, trap, 'shock', mine.blast);
      for (const p of active) if (distance(p, trap) < mine.blast && lineClear(s.map, trap, p)) damage(s, p, mine.damage, null);
    } else if (trap.kind === 'turret') {
      const turret = s.content.traps.turret;
      const target = active.filter(p => distance(p, trap) < turret.range && lineClear(s.map, trap, p)).sort((a, b) => distance(a, trap) - distance(b, trap))[0];
      if (!target) { trap.aiming = false; continue; }
      trap.aiming = true; trap.heading = Math.atan2(target.y - trap.y, target.x - trap.x);
      if (!trap.cooldown) {
        trap.cooldown = turret.cooldown;
        s.projectiles.push({ id: s.serial++, owner: trap.id, trap: true, x: trap.x, y: trap.y, dx: Math.cos(trap.heading) * turret.speed, dy: Math.sin(trap.heading) * turret.speed, damage: turret.damage, life: turret.life });
      }
    } else if (trap.kind === 'flame') {
      const flame = s.content.traps.flame;
      const phase = (s.tick + trap.offset) % flame.cycle;
      trap.firing = phase >= flame.fireAt; trap.warning = phase >= flame.warnAt && phase < flame.fireAt;
      if (!trap.firing || s.tick % flame.interval) continue;
      for (const p of active) if (distance(p, trap) < flame.range && Math.cos(Math.atan2(p.y - trap.y, p.x - trap.x) - trap.heading) > flame.cone && lineClear(s.map, trap, p)) damage(s, p, flame.damage, null);
    } else if (trap.kind === 'spider') {
      const spider = s.content.traps.spider;
      const home = { x: trap.homeX, y: trap.homeY };
      // A spider holds a target it already has out to the full leash, but acquires a new one only
      // well inside it, so it never latches onto someone it could not reach.
      let target = active.find(p => p.id === trap.targetId && distance(p, home) < spider.leash);
      if (!target) target = active.filter(p => distance(p, home) < spider.acquire && lineClear(s.map, trap, p)).sort((a, b) => distance(a, trap) - distance(b, trap))[0];
      trap.targetId = (target?.id ?? null) as PlayerId | null;
      const destination = target || home, length = distance(trap, destination);
      trap.heading = Math.atan2(destination.y - trap.y, destination.x - trap.x);
      if (length > 20) {
        const x = trap.x + Math.cos(trap.heading) * spider.step, y = trap.y + Math.sin(trap.heading) * spider.step;
        if (distance({ x, y }, home) <= spider.leash && canOccupy(s.map, x, y, 15)) { trap.x = x; trap.y = y; }
      }
      if (target && !trap.cooldown && distance(trap, target) < spider.grapple && lineClear(s.map, trap, target)) {
        trap.cooldown = spider.cooldown; target.stun = Math.max(target.stun, spider.stun); damage(s, target, spider.damage, null); effect(s, target, 'grapple', 35);
      }
    }
  }
}
