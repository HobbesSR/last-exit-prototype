import { canOccupy, lineClear } from '../movement.js';
import { WEAPONS, equipped, syncWeapon } from '../equipment.js';
import { HZ, KITS } from './rules.js';
import { distance } from './geometry.js';
import { effect } from './loot.js';
import { eliminate } from './lifecycle.js';
export function damage(s, target, amount, source) {
  if (target.status !== 'active') return;
  const blocked = Math.min(target.shield, amount);
  target.shield -= blocked; target.hp = Math.max(0, target.hp - amount + blocked);
  if (source && source.id !== target.id) { target.aggressor = source.id; target.aggressionUntil = s.tick + 10 * HZ; }
  if (target.hp > 0) return;
  eliminate(s, target, source);
}
export function skill(s, p) {
  if (p.cooldown > 0) return;
  if (p.role === 'contestant') return;
  p.cooldown = Math.max(45, KITS[p.kit].cooldown - (p.level - 1) * 12);
  if (p.kit === 'warden') {
    effect(s, p, 'shock', 130);
    for (const t of s.players) if (t.role !== p.role && t.status === 'active' && distance(p, t) < 130 && lineClear(s.map, p, t)) { damage(s, t, 18 + 5 * p.level, p); t.stun = 22; }
  } else if (p.kit === 'specter') {
    effect(s, p, 'scan', 450);
    for (const t of s.players) if (t.role !== p.role && distance(p, t) < 450) t.revealed = 110;
  } else { p.boost = 55; effect(s, p, 'upgrade', 75); }
}
export function attack(s, p) {
  if (p.attackCd > 0) return;
  if (p.role === 'gladiator') {
    p.attackCd = 13; effect(s, { x: p.x + Math.cos(p.heading) * 30, y: p.y + Math.sin(p.heading) * 30 }, 'slash', 55);
    const t = s.players.filter(t => t.role !== p.role && t.status === 'active' && distance(p, t) < 86 && Math.cos(Math.atan2(t.y - p.y, t.x - p.x) - p.heading) > 0.25 && lineClear(s.map, p, t)).sort((a, b) => distance(p, a) - distance(p, b))[0];
    if (t) damage(s, t, KITS[p.kit].damage + (p.level - 1) * 4, p);
  } else {
    const item = equipped(p);
    if (!item) return;
    if (item.kind === 'med' || item.kind === 'shield') {
      if (item.kind === 'med' && p.hp >= p.maxHp || item.kind === 'shield' && p.shield >= 75) return;
      if (item.kind === 'med') p.hp = Math.min(p.maxHp, p.hp + 40);
      else p.shield = Math.min(75, p.shield + 30);
      if (--item.count <= 0) p.inventory[p.selectedSlot] = null;
      p.attackCd = HZ; syncWeapon(p); effect(s, p, 'loot', 30); return;
    }
    const weapon = WEAPONS[item.weaponType]; if (!weapon) return;
    item.ammo ??= weapon.ammo;
    if (item.ammo <= 0) return;
    item.ammo--;
    p.attackCd = weapon.cooldown;
    for (const spread of weapon.spread) s.projectiles.push({ id: s.serial++, owner: p.id, x: p.x, y: p.y, dx: Math.cos(p.heading + spread) * weapon.speed, dy: Math.sin(p.heading + spread) * weapon.speed, life: weapon.life, damage: weapon.damage }); p.cloak = 0;
  }
}
export function advanceProjectiles(s) {
  s.projectiles = s.projectiles.filter(b => {
    const previous = { x: b.x, y: b.y }; b.x += b.dx; b.y += b.dy; b.life--;
    if (b.life <= 0) return false;
    const lengthSquared = b.dx * b.dx + b.dy * b.dy;
    const hits = s.players.filter(p => p.id !== b.owner && p.status === 'active').map(p => {
      const t = Math.max(0, Math.min(1, ((p.x - previous.x) * b.dx + (p.y - previous.y) * b.dy) / lengthSquared));
      const point = { x: previous.x + b.dx * t, y: previous.y + b.dy * t };
      return { p, t, point, hit: distance(p, point) < (p.role === 'gladiator' ? 26 : 15) };
    }).filter(h => h.hit).sort((a, b) => a.t - b.t);
    if (hits.length && lineClear(s.map, previous, hits[0].point)) { damage(s, hits[0].p, b.damage, s.players.find(p => p.id === b.owner)); return false; }
    if (!canOccupy(s.map, b.x, b.y, 2, false, true) || !lineClear(s.map, previous, b)) return false;
    return true;
  });
}
