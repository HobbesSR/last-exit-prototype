import { WEAPONS } from '../equipment.ts';
import { KITS, DURATION, CELL_CHARGE_TICKS, GLADIATOR_RESPAWN_TICKS, HAZARD_GRACE_TICKS } from './rules.ts';
import type { MatchContent } from '../types.ts';

// The values a match's `MatchContent` is pinned to, and the copy it takes of them.
/*
 *
 * Weapon and kit tables and the tick-denominated rules were read straight from module constants, so
 * a match had no content of its own: it used whatever the process happened to hold. That is fine
 * while the numbers never change, and stops being fine the moment they do. A recording made before a
 * balance change would replay against the new numbers and quietly mean something different, and a
 * match in progress would change under its players.
 *
 * Pinning is what makes a content change a versioned event rather than an ambient one. A match takes
 * a copy at creation and reads that copy for the rest of its life; the copy is deep frozen, so the
 * simulation cannot edit the balance it is running under even by accident. The recording records
 * which set it was, so a reader can say what the numbers meant rather than guessing.
 *
 * Deliberately not in `Snapshot`. Content is fixed for the whole match, so a per-frame copy would
 * repeat the same tables thousands of times; the recording header names it once instead.
 */

/**
 * The content set this build ships.
 *
 * Bump it when any value in `defaultContent` changes, the way a recording's schema is bumped for a
 * format change. It identifies balance, where `VERSION` identifies rules: two matches can run the
 * same rules over different numbers, and a reader looking at an old recording needs to tell which.
 */
export const CONTENT_ID = 'content-1';

/** Recursively freeze, so a match cannot edit the balance it is running under. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/**
 * A match's own copy of the shipped content.
 *
 * Cloned rather than shared, so one match can be given different numbers without reaching into
 * another's, which is the point of pinning at all.
 */
export function defaultContent(): MatchContent {
  return deepFreeze(structuredClone({
    id: CONTENT_ID,
    roster: {
      contestants: ['Mica', 'Juno', 'Patch', 'Pip', 'Nova', 'Rook', 'Echo', 'Sol'],
      gladiators: [{ name: 'IRONCLAD', kit: 'warden' }, { name: 'VESPER', kit: 'specter' }],
    },
    weapons: WEAPONS,
    kits: KITS,
    durationTicks: DURATION,
    cellChargeTicks: CELL_CHARGE_TICKS,
    gladiatorRespawnTicks: GLADIATOR_RESPAWN_TICKS,
    hazardGraceTicks: HAZARD_GRACE_TICKS,
  }));
}
