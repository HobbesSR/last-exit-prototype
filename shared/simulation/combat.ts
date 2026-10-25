import { canOccupy, lineClear } from '../movement.ts';
import { equipped, syncWeapon } from '../equipment.ts';
import { qualityDamage } from '../loot-tiers.ts';
import { HZ } from './rules.ts';
import { distance } from './geometry.ts';
import { effect } from './loot.ts';
import { eliminate } from './lifecycle.ts';
import { asSeenBy } from './rewind.ts';
import { hookSkill } from './hook.ts';
import { actorHitRadius } from './swept.ts';
import type { Game, Player, InventoryItem, StackItem } from '../types.ts';

type UtilityState = Pick<Player, 'hp' | 'maxHp' | 'shield'>;

/** Whether this utility can change the current health/shield state. */
export function utilityApplies(p: UtilityState, item: InventoryItem | null | undefined): item is StackItem {
  return item?.kind === 'med' ? p.hp < p.maxHp : item?.kind === 'shield' && p.shield < 75;
}

/** Pure utility effect, shared by actual use and bots previewing their own use. */
export function utilityOutcome(p: UtilityState, item: InventoryItem | null | undefined): Pick<Player, 'hp' | 'shield'> | null {
  if (!utilityApplies(p, item)) return null;
  return item.kind === 'med' ? { hp: Math.min(p.maxHp, p.hp + 40), shield: p.shield }
    : { hp: p.hp, shield: Math.min(75, p.shield + 30) };
}

export function damage(s: Game, target: Player, amount: number, source: Player | null): void {
  if (target.status !== 'active') return;
  const blocked = Math.min(target.shield, amount);
  target.shield -= blocked; target.hp = Math.max(0, target.hp - amount + blocked);
  if (source && source.id !== target.id) { target.aggressor = source.id; target.aggressionUntil = s.tick + 10 * HZ; }
  if (target.hp > 0) return;
  eliminate(s, target, source);
}
export function skill(s: Game, p: Player): void {
  if (p.kit === 'hook') { hookSkill(s, p); return; }
  if (p.cooldown > 0) return;
  if (p.role === 'contestant') return;
  p.cooldown = Math.max(45, s.content.kits[p.kit].cooldown - (p.level - 1) * 12);
  if (p.kit === 'warden') {
    effect(s, p, 'shock', 130);
    // Resolved against where the caster saw them. The ring is drawn at the caster's own position, so
    // nothing about the effect moves; only whether a target was inside it when they were aimed at.
    const seen = asSeenBy(s, p);
    for (const t of s.players) if (t.role !== p.role && t.status === 'active' && distance(p, seen(t)) < 130 && lineClear(s.map, p, seen(t))) { damage(s, t, 18 + 5 * p.level, p); t.stun = 22; }
  } else if (p.kit === 'specter') {
    effect(s, p, 'scan', 450);
    for (const t of s.players) if (t.role !== p.role && distance(p, t) < 450) t.revealed = 110;
  } else { p.boost = 55; effect(s, p, 'upgrade', 75); }
}
export function attack(s: Game, p: Player): void {
  if (p.attackCd > 0) return;
  if (p.role === 'gladiator') {
    p.attackCd = 13; effect(s, { x: p.x + Math.cos(p.heading) * 30, y: p.y + Math.sin(p.heading) * 30 }, 'slash', 55);
    // Range, arc and cover all read the positions this gladiator was looking at when they swung.
    const seen = asSeenBy(s, p);
    const t = s.players.filter(t => t.role !== p.role && t.status === 'active' && distance(p, seen(t)) < 86 && Math.cos(Math.atan2(seen(t).y - p.y, seen(t).x - p.x) - p.heading) > 0.25 && lineClear(s.map, p, seen(t))).sort((a, b) => distance(p, seen(a)) - distance(p, seen(b)))[0];
    if (t) damage(s, t, s.content.kits[p.kit]!.damage + (p.level - 1) * 4, p);
  } else {
    const item = equipped(p);
    // An L2 reload blocks attacking until it completes or is cancelled.
    if (!item || p.reload) return;
    if (item.kind === 'med' || item.kind === 'shield') {
      const outcome = utilityOutcome(p, item);
      if (!outcome) return;
      Object.assign(p, outcome);
      if (--item.count <= 0) p.inventory![p.selectedSlot!] = null;
      p.attackCd = HZ; syncWeapon(p, s.content.weapons); effect(s, p, 'loot', 30); return;
    }
    // A carried cell is not a firearm; the original fell through the same way on a missing spec.
    if (item.kind !== 'weapon') return;
    const weapon = s.content.weapons[item.weaponType]; if (!weapon) return;
    item.ammo ??= weapon.ammo;
    if (item.ammo <= 0) return;
    item.ammo--;
    p.attackCd = weapon.cooldown;
    for (const spread of weapon.spread) s.projectiles.push({ id: s.serial++, owner: p.id, x: p.x, y: p.y, dx: Math.cos(p.heading + spread) * weapon.speed, dy: Math.sin(p.heading + spread) * weapon.speed, life: weapon.life, damage: weapon.damage * qualityDamage(s.content, item) }); p.cloak = 0;
  }
}
export function advanceProjectiles(s: Game): void {
  s.projectiles = s.projectiles.filter(b => {
    const previous = { x: b.x, y: b.y }; b.x += b.dx; b.y += b.dy; b.life--;
    if (b.life <= 0) return false;
    const lengthSquared = b.dx * b.dx + b.dy * b.dy;
    const hits = s.players.filter(p => p.id !== b.owner && p.status === 'active').map(p => {
      const t = Math.max(0, Math.min(1, ((p.x - previous.x) * b.dx + (p.y - previous.y) * b.dy) / lengthSquared));
      const point = { x: previous.x + b.dx * t, y: previous.y + b.dy * t };
      return { p, t, point, hit: distance(p, point) < actorHitRadius(p.role) };
    }).filter(h => h.hit).sort((a, b) => a.t - b.t);
    if (hits.length && lineClear(s.map, previous, hits[0].point)) { damage(s, hits[0].p, b.damage, s.players.find(p => p.id === b.owner) ?? null); return false; }
    if (!canOccupy(s.map, b.x, b.y, 2, false, true) || !lineClear(s.map, previous, b)) return false;
    return true;
  });
}
