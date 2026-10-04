import { generateBriefRegion } from './index.ts';
import { CORE_ELEMENT_KINDS } from '../kernel/contract.ts';
import { buildCover } from './strategies/cover.ts';
import { buildHut } from './strategies/hut.ts';
import { buildOpen } from './strategies/open.ts';
import { buildRubble } from './strategies/rubble.ts';
import { buildRuins } from './strategies/ruins.ts';
import { buildHall } from './strategies/hall.ts';
import { buildDepot } from './strategies/depot.ts';
import { buildArrival } from './strategies/arrival.ts';
import { buildDeparture } from './strategies/departure.ts';
import { buildCharging } from './strategies/charging.ts';
import { buildTransit } from './strategies/transit.ts';
import type { BuiltRegion, RegionBrief, RegionTypeId } from './types.ts';

/** A region type's strategy: its decomposer, if it has one, and its builders (51 stage 6). */
export type RegionStrategy = (brief: RegionBrief) => BuiltRegion;
export type RegionTypeRegistry = Readonly<Record<RegionTypeId, RegionStrategy>>;

/**
 * The game's region types. A catalogue type (54) is registered under its own name once
 * B3 writes its strategy, in `strategies/`. The rest are today's example builders, which
 * stand in until then. The `example-` prefix keeps a library from binding to them by accident.
 */
export const REGION_TYPES: RegionTypeRegistry = Object.freeze({
  open: buildOpen,
  rubble: buildRubble,
  ruins: buildRuins,
  hall: buildHall,
  depot: buildDepot,
  cover: buildCover,
  hut: buildHut,
  arrival: buildArrival,
  departure: buildDeparture,
  charging: buildCharging,
  transit: buildTransit,
  'example-open': brief => generateBriefRegion(brief, 'open'),
  'example-depot': brief => generateBriefRegion(brief, 'depot'),
  'example-courtyard': brief => generateBriefRegion(brief, 'courtyard'),
  'example-ruins': brief => generateBriefRegion(brief, 'ruins'),
  'example-entry': brief => generateBriefRegion(brief, 'entry'),
});

/**
 * Names what `REGION_TYPES` builds. A change to what any of its strategies builds bumps it,
 * so a saved map's results are never rebuilt by other strategies without saying so (51 "Saving").
 */
export const REGION_TYPES_VERSION = 'types-11';

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
