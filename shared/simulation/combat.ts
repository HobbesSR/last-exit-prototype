import { physicsRuntime } from './physics-runtime.ts';
import { equipped, syncWeapon } from '../equipment.ts';
import { qualityDamage } from '../loot-tiers.ts';
import { cos, sin } from '../math.ts';
import { hearShot } from './hearing.ts';
import { HZ } from './rules.ts';
import { distance } from './geometry.ts';
import { effect } from './event-records.ts';
import { hookSkill } from './hook.ts';
import { attackInCore } from './phase-three.ts';
import { castersInCore, damageInCore } from './phase-five.ts';
import { UTILITY_RULES } from './action-records.ts';
import type { Game, Player, InventoryItem, StackItem } from '../types.ts';

type UtilityState = Pick<Player, 'hp' | 'maxHp' | 'shield'>;

/** Whether this utility can change the current health/shield state. */
export function utilityApplies(p: UtilityState, item: InventoryItem | null | undefined): item is StackItem {
  return item?.kind === 'med' ? p.hp < p.maxHp : item?.kind === 'shield' && p.shield < UTILITY_RULES.maxShield;
}

/** Pure utility preview; actual core use receives the same rules and is checked for parity. */
export function utilityOutcome(p: UtilityState, item: InventoryItem | null | undefined): Pick<Player, 'hp' | 'shield'> | null {
  if (!utilityApplies(p, item)) return null;
  return item.kind === 'med' ? { hp: Math.min(p.maxHp, p.hp + UTILITY_RULES.medHealth), shield: p.shield }
    : { hp: p.hp, shield: Math.min(UTILITY_RULES.maxShield, p.shield + UTILITY_RULES.shieldAmount) };
}

/**
 * `damage` and the elimination it may cause run in the core (`rust/core/src/combat.rs`, #1242, docs/27 step 5d.2), so
 * they need the game's physics world; this is their entry for phase 6's callers and scenarios.
 */
export function damage(s: Game, target: Player, amount: number, source: Player | null): void {
  if (!physicsRuntime(s)) throw new Error("damage runs in the core and needs the game's physics world");
  damageInCore(s, target, amount, source);
}
/**
 * A skill press outside the tick, for scenarios. The warden's runs in the core, as phase 5's caster run (which reads
 * the caster's status at its turn); the hook's is `hookSkill`; specter and striker are phase 3's in the core, with
 * this record-level copy held equal by `tests/action-parity.test.js` (27's retained-copy ledger, #1241).
 */
export function skill(s: Game, p: Player): void {
  if (p.kit === 'hook') { hookSkill(s, p); return; }
  if (p.kit === 'warden') { castersInCore(s, [{ player: p, skill: true, attack: false }]); return; }
  if (p.cooldown > 0) return;
  if (p.role === 'contestant') return;
  p.cooldown = Math.max(45, s.content.kits[p.kit].cooldown - (p.level - 1) * 12);
  if (p.kit === 'specter') {
    effect(s, p, 'scan', 450);
    for (const t of s.players) if (t.role !== p.role && distance(p, t) < 450) t.revealed = 110;
  } else { p.boost = 55; effect(s, p, 'upgrade', 75); }
}
/**
 * An attack outside the tick, for scenarios. A gladiator's runs as phase 5's caster run in the core; a contestant's is
 * phase 3's core attack, and a bare record (no physics world) keeps the record-level copy below (#1241).
 */
export function attack(s: Game, p: Player): void {
  if (p.role === 'gladiator') { castersInCore(s, [{ player: p, skill: false, attack: true }]); return; }
  if (physicsRuntime(s)) { attackInCore(s, p); return; }
  if (p.attackCd > 0) return;
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
  for (const spread of weapon.spread) s.projectiles.push({ id: s.serial++, owner: p.id, x: p.x, y: p.y, dx: cos(p.heading + spread) * weapon.speed, dy: sin(p.heading + spread) * weapon.speed, life: weapon.life, damage: weapon.damage * qualityDamage(s.content, item) }); p.cloak = 0;
  hearShot(s, p, item.weaponType);
}
