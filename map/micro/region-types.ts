import { generateBriefRegion } from './index.ts';
import { CORE_ELEMENT_KINDS } from '../kernel/contract.ts';
import type { BuiltRegion, RegionBrief, RegionTypeId } from './types.ts';

/** A region type's strategy: its decomposer, if it has one, and its builders (51 stage 6). */
export type RegionStrategy = (brief: RegionBrief) => BuiltRegion;
export type RegionTypeRegistry = Readonly<Record<RegionTypeId, RegionStrategy>>;

/**
 * The game's region types. These are today's example builders, standing in until the
 * catalogue (54, B2) names the real types and B3 writes their strategies. The `example-`
 * prefix keeps a library from binding to them by accident.
 */
export const REGION_TYPES: RegionTypeRegistry = Object.freeze({
  'example-open': brief => generateBriefRegion(brief, 'open'),
  'example-depot': brief => generateBriefRegion(brief, 'depot'),
  'example-courtyard': brief => generateBriefRegion(brief, 'courtyard'),
  'example-ruins': brief => generateBriefRegion(brief, 'ruins'),
  'example-entry': brief => generateBriefRegion(brief, 'entry'),
});

/**
 * Dispatch a brief to its region type's strategy (51 stage 6). The brief is checked as
 * input. The result is not: a builder's promise is its own to check (51 principle 9).
 */
export function buildRegion(brief: RegionBrief, registry: RegionTypeRegistry = REGION_TYPES): BuiltRegion {
  const errors = briefErrors(brief);
  if (errors.length) throw new Error(`Invalid brief: ${errors.join(' ')}`);
  if (!Object.hasOwn(registry, brief.type)) throw new Error(`Unknown region type ${brief.type}.`);
  return registry[brief.type]!(structuredClone(brief));
}

/** The brief's own shape. Region size and scale limits are the SDK's, checked when a builder runs. */
export function briefErrors(brief: RegionBrief): string[] {
  const errors: string[] = [];
  if (!brief || typeof brief !== 'object') return ['A brief must be an object.'];
  if (typeof brief.id !== 'string' || !brief.id || !Number.isSafeInteger(brief.seed)) errors.push('A brief needs a stable id and integer seed.');
  if (typeof brief.type !== 'string' || !brief.type) errors.push('A brief needs a region type.');
  if (!Array.isArray(brief.cells) || !brief.cells.length) return [...errors, 'A brief needs cells.'];
  if (!Array.isArray(brief.portals)) errors.push('A brief lists its portals, even when there are none.');
  const cells = new Set(brief.cells.map(c => `${c.x},${c.y}`)), zoned = new Set<string>();
  for (const zone of Array.isArray(brief.zones) ? brief.zones : []) {
    if (!Number.isInteger(zone.tier) || zone.tier < 1 || zone.tier > 5 || !Number.isInteger(zone.bonus) || zone.bonus < 0
      || !Number.isFinite(zone.lootChance) || zone.lootChance < 0 || zone.lootChance > 1) errors.push('A zone needs a tier from 1 to 5, a whole bonus and a loot chance from 0 to 1.');
    for (const c of Array.isArray(zone.cells) ? zone.cells : []) {
      const key = `${c.x},${c.y}`;
      if (!cells.has(key) || zoned.has(key)) errors.push(`Zone cell ${key} is outside the brief or in two zones.`);
      zoned.add(key);
    }
  }
  if (zoned.size !== cells.size) errors.push('Every brief cell needs exactly one zone.');
  for (const [kind, count] of Object.entries(brief.coreElements ?? {})) {
    if (!CORE_ELEMENT_KINDS.includes(kind as never)) errors.push(`Unknown core element ${kind}.`);
    if (!Number.isSafeInteger(count) || count! < 0) errors.push(`Core element ${kind} needs a whole count.`);
  }
  return errors;
}
