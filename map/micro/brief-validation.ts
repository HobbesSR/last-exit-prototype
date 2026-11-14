import { hintErrors } from './hints.ts';
import { checkedRegionCells } from './limits.ts';
import { CORE_ELEMENT_KINDS } from '../kernel/contract.ts';
import type { RegionBrief } from './types.ts';

/**
 * The brief's own shape, and the SDK's region limits (20), checked here once for every
 * strategy rather than by each builder that happens to (20.1).
 */
export function briefShapeErrors(brief: RegionBrief): string[] {
  const errors: string[] = [];
  if (!brief || typeof brief !== 'object') return ['A brief must be an object.'];
  if (typeof brief.id !== 'string' || !brief.id || !Number.isSafeInteger(brief.seed)) errors.push('A brief needs a stable id and integer seed.');
  if (typeof brief.type !== 'string' || !brief.type) errors.push('A brief needs a region type.');
  if (!Array.isArray(brief.cells) || !brief.cells.length) return [...errors, 'A brief needs cells.'];
  try { checkedRegionCells(brief.cells); } catch (error) { errors.push((error as Error).message); }
  if (!Array.isArray(brief.portals)) errors.push('A brief lists its portals, even when there are none.');
  const cells = new Set(brief.cells.map(c => `${c.x},${c.y}`)), zoned = new Set<string>();
  const sets = new Map<string, Set<string>>();
  for (const field of ['fillCells', 'clearCells'] as const) {
    const listed = brief[field];
    if (listed === undefined) continue;
    if (!Array.isArray(listed)) { errors.push(`${field} must be a cell list.`); continue; }
    const seen = new Set<string>();
    for (const c of listed) {
      if (!c || !Number.isSafeInteger(c.x) || !Number.isSafeInteger(c.y)) { errors.push(`${field} needs whole cell addresses.`); continue; }
      const key = `${c.x},${c.y}`;
      if (seen.has(key)) errors.push(`${field} contains duplicate cell ${key}.`);
      seen.add(key);
      if (field === 'fillCells' && !cells.has(key)) errors.push(`Fill cell ${key} is outside original ownership.`);
      if (field === 'clearCells') {
        let nearby = false;
        for (let dy = -1; dy <= 1 && !nearby; dy++) for (let dx = -1; dx <= 1; dx++)
          if (cells.has(`${c.x + dx},${c.y + dy}`)) { nearby = true; break; }
        if (!nearby) errors.push(`Clear cell ${key} is outside the region's nearby access context.`);
      }
    }
    sets.set(field, seen);
  }
  for (const key of sets.get('clearCells') ?? []) if ((sets.get('fillCells') ?? cells).has(key))
    errors.push(`Clear cell ${key} is available for filling.`);
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
  errors.push(...hintErrors(brief));
  for (const [kind, count] of Object.entries(brief.coreElements ?? {})) {
    if (!CORE_ELEMENT_KINDS.includes(kind as never)) errors.push(`Unknown core element ${kind}.`);
    if (!Number.isSafeInteger(count) || count! < 0) errors.push(`Core element ${kind} needs a whole count.`);
  }
  return errors;
}
