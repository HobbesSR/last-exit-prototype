import { canOccupy, lineClear } from './movement.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function stepTraps(s, damage, effect) {
  for (const trap of s.map.traps || []) {
    if (trap.spent) continue;
    trap.cooldown = Math.max(0, (trap.cooldown || 0) - 1);
    const active = s.players.filter(p => p.status === 'active');
    if (trap.kind === 'mine') {
      if (!active.some(p => distance(p, trap) < 65 && p.movedThisTick > 0.5 && lineClear(s.map, trap, p))) continue;
      trap.spent = true; effect(s, trap, 'shock', 120);
      for (const p of active) if (distance(p, trap) < 120 && lineClear(s.map, trap, p)) damage(s, p, 45, null);
    } else if (trap.kind === 'turret') {
      const target = active.filter(p => distance(p, trap) < 650 && lineClear(s.map, trap, p)).sort((a, b) => distance(a, trap) - distance(b, trap))[0];
      if (!target) { trap.aiming = false; continue; }
      trap.aiming = true; trap.heading = Math.atan2(target.y - trap.y, target.x - trap.x);
      if (!trap.cooldown) {
        trap.cooldown = 35;
        s.projectiles.push({ id: s.serial++, owner: trap.id, trap: true, x: trap.x, y: trap.y, dx: Math.cos(trap.heading) * 24, dy: Math.sin(trap.heading) * 24, damage: 12, life: 30 });
      }
    } else if (trap.kind === 'flame') {
      const phase = (s.tick + trap.offset) % 160;
      trap.firing = phase >= 120; trap.warning = phase >= 80 && phase < 120;
      if (!trap.firing || s.tick % 5) continue;
      for (const p of active) if (distance(p, trap) < 240 && Math.cos(Math.atan2(p.y - trap.y, p.x - trap.x) - trap.heading) > 0.8 && lineClear(s.map, trap, p)) damage(s, p, 6, null);
    } else if (trap.kind === 'spider') {
      const home = { x: trap.homeX, y: trap.homeY };
      let target = active.find(p => p.id === trap.targetId && distance(p, home) < 360);
      if (!target) target = active.filter(p => distance(p, home) < 240 && lineClear(s.map, trap, p)).sort((a, b) => distance(a, trap) - distance(b, trap))[0];
      trap.targetId = target?.id || null;
      const destination = target || home, length = distance(trap, destination);
      trap.heading = Math.atan2(destination.y - trap.y, destination.x - trap.x);
      if (length > 20) {
        const x = trap.x + Math.cos(trap.heading) * 5, y = trap.y + Math.sin(trap.heading) * 5;
        if (distance({ x, y }, home) <= 360 && canOccupy(s.map, x, y, 15)) { trap.x = x; trap.y = y; }
      }
      if (target && !trap.cooldown && distance(trap, target) < 150 && lineClear(s.map, trap, target)) {
        trap.cooldown = 50; target.stun = Math.max(target.stun, 30); damage(s, target, 10, null); effect(s, target, 'grapple', 35);
      }
    }
  }
}
