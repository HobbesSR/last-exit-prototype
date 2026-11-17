/** Closed, explicitly ordered vocabularies for relational tables and outward descriptors. */
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

/** Check a content key against the build's closed vocabulary at the boundary. */
export function assertEnumKeys(table: object, ordered: readonly string[], label: string): void {
  for (const key of Object.keys(table)) {
    if (!ordered.includes(key)) throw new RangeError(`Unknown ${label}: ${key}`);
  }
}
