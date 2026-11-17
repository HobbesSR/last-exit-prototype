/** Closed, explicitly ordered vocabularies for relational tables and outward descriptors. */
import type { AmmoFamily, EffectKind, ItemKind, Kit, Phase, Role, TrapKind, WeaponType } from './types.ts';
import type { BodyKind, BodyShape } from './physics/types.ts';
export const ROLES = Object.freeze(['contestant', 'gladiator'] as const);
export const KITS = Object.freeze(['warden', 'specter', 'striker', 'hook'] as const);
export const WEAPONS = Object.freeze(['pistol', 'rifle', 'scattergun'] as const);
export const PHASES = Object.freeze(['live', 'finished'] as const);
export const AMMO_FAMILIES = Object.freeze(['pistol', 'rifle', 'shell'] as const);
export const ITEM_KINDS = Object.freeze(['weapon', 'med', 'shield', 'cell', 'access', 'ammo'] as const);
export const BODY_KINDS = Object.freeze(['actor', 'prop', 'static'] as const);
export const SHAPE_KINDS = Object.freeze(['circle', 'box', 'convex'] as const);
export const EFFECT_KINDS = Object.freeze(['shock', 'scan', 'slash', 'loot', 'upgrade', 'rail', 'charge', 'grapple'] as const);
export const TRAP_KINDS = Object.freeze(['mine', 'turret', 'flame', 'spider'] as const);
export const EVENT_KINDS = Object.freeze(['pod_powered', 'cell_charged', 'eliminated', 'respawned', 'match_finished'] as const);

// Generic bounds reject extra entries; Exclude rejects missing members when a union grows.
type Missing<T, Entries extends readonly T[]> = Exclude<T, Entries[number]>;
type Complete<T extends never> = T;
export type EnumTableCoverage = Complete<
  Missing<Role, typeof ROLES> | Missing<Kit, typeof KITS> | Missing<WeaponType, typeof WEAPONS>
  | Missing<Phase, typeof PHASES> | Missing<AmmoFamily, typeof AMMO_FAMILIES>
  | Missing<ItemKind, typeof ITEM_KINDS> | Missing<BodyKind, typeof BODY_KINDS>
  | Missing<BodyShape['kind'], typeof SHAPE_KINDS> | Missing<EffectKind, typeof EFFECT_KINDS>
  | Missing<TrapKind, typeof TRAP_KINDS>
>;
// EVENT_KINDS will be checked against the structured GameEvent union when #1153 introduces it.

/** Check a content key against the build's closed vocabulary at the boundary. */
export function assertEnumKeys(table: object, ordered: readonly string[], label: string): void {
  for (const key of Object.keys(table)) {
    if (!ordered.includes(key)) throw new RangeError(`Unknown ${label}: ${key}`);
  }
}
