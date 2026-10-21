import { contentById } from './simulation/content.ts';
import type { ContentPresentation, MatchContent, RecordingPresentation } from './types.ts';

/**
 * The display side of a match's content (22.7): a plain, frozen descriptor a browser can label a
 * match with, and the rules for finding one for a recording. Display data only. It holds no actor,
 * secret or command, cannot instantiate a simulation, and grants nothing; the server still decides
 * which kit, pickup or input is allowed.
 */

const freeze = (p: ContentPresentation): ContentPresentation => {
  for (const entry of [...p.weapons, ...p.kits]) Object.freeze(entry);
  Object.freeze(p.weapons); Object.freeze(p.kits); Object.freeze(p.capacity);
  return Object.freeze(p);
};

/** Describe content for display, keeping its tables' entry order. */
export function describeContent(content: MatchContent): ContentPresentation {
  return freeze({
    contentId: content.id,
    weapons: Object.entries(content.weapons).map(([id, w]) => ({ id, name: w.name, ammo: w.ammo })),
    // The kits on offer, not only those the roster starts with: content-1 seats two hunters among three kits.
    kits: Object.entries(content.kits).map(([id, k]) => ({ id, name: k.name, skill: k.skill })),
    capacity: { contestant: content.roster.contestants.length, gladiator: content.roster.gladiators.length },
    durationTicks: content.durationTicks,
    cellChargeTicks: content.cellChargeTicks,
  });
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

function entries<T>(value: unknown, read: (entry: Record<string, unknown>) => T | null): (T & { id: string })[] | null {
  if (!Array.isArray(value)) return null;
  const out: (T & { id: string })[] = [], seen = new Set<string>();
  for (const entry of value) {
    if (!record(entry) || !id(entry.id) || seen.has(entry.id)) return null;
    const fields = read(entry);
    if (!fields) return null;
    seen.add(entry.id); out.push({ id: entry.id, ...fields });
  }
  return out;
}

/**
 * A validated, detached copy of a descriptor, or null. The whole shape must hold: nothing is merged
 * piecemeal with this build's content. Extra fields are dropped. With `expectedContentId`, the
 * descriptor must name exactly that content.
 */
export function readPresentation(value: unknown, expectedContentId?: string): ContentPresentation | null {
  if (!record(value) || !id(value.contentId)) return null;
  if (expectedContentId !== undefined && value.contentId !== expectedContentId) return null;
  const weapons = entries(value.weapons, e => typeof e.name === 'string' && count(e.ammo) ? { name: e.name, ammo: e.ammo } : null);
  const kits = entries(value.kits, e => typeof e.name === 'string' && typeof e.skill === 'string' ? { name: e.name, skill: e.skill } : null);
  const capacity = value.capacity;
  if (!weapons || !kits || !record(capacity) || !count(capacity.contestant) || !count(capacity.gladiator)) return null;
  if (!positive(value.durationTicks) || !positive(value.cellChargeTicks)) return null;
  return freeze({
    contentId: value.contentId, weapons, kits,
    capacity: { contestant: capacity.contestant, gladiator: capacity.gladiator },
    durationTicks: value.durationTicks, cellChargeTicks: value.cellChargeTicks,
  });
}

/** A local-only id for archives that predate content ids. Never a match's content id. */
export const LEGACY_DISPLAY_ID = 'legacy-display';

/**
 * How an archive without a content id has always been shown: content-1's vocabulary and ammo, and
 * the client's old 2400-tick clock and 100-tick charge fallbacks. Historical display compatibility,
 * not a claim that such an archive ran content-1 or today's rules.
 */
const LEGACY = freeze({ ...describeContent(contentById('content-1')), contentId: LEGACY_DISPLAY_ID, durationTicks: 2400, cellChargeTicks: 100 });

function retained(contentId: string): ContentPresentation | null {
  try { return describeContent(contentById(contentId)); } catch { return null; }
}

/**
 * Display metadata for a recording header, in order: a valid embedded descriptor matching its content
 * id (even one this build does not know), the retained descriptor of a known id, the legacy profile
 * when the header has no content id, and otherwise none. Never a format error, and never a resimulation;
 * `recordingFit` alone decides whether the archive plays.
 */
export function resolveRecordingPresentation(header: unknown): RecordingPresentation {
  const h = record(header) ? header : {};
  if (!Object.hasOwn(h, 'contentId')) return { source: 'legacy', presentation: LEGACY };
  const contentId = h.contentId;
  if (!id(contentId)) return { source: 'unknown', presentation: null };
  const embedded = readPresentation(h.presentation, contentId);
  if (embedded) return { source: 'embedded', presentation: embedded };
  const known = retained(contentId);
  return known ? { source: 'retained', presentation: known } : { source: 'unknown', presentation: null };
}
