import type { MatchContent } from '../types.ts';

// The values a match's `MatchContent` is pinned to, and the copy it takes of them.
/*
 *
 * Weapon and kit tables and the tick-denominated rules were read straight from module constants, so
 * a match had no content of its own: it used whatever the process happened to hold. That is fine
 * while the numbers never change, and stops being fine the moment they do. A recording header could
 * not identify the tuning that produced its frames, and a match in progress would change under its
 * players.
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
export const CONTENT_ID = 'content-2';

/** Recursively freeze, so a match cannot edit the balance it is running under. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// Keep this complete literal separate from the shipped default. Its values and roster are the
// retained `content-1` contract used by the frozen characterization fixture; later default edits
// and mutable exported tables must not silently rewrite what that fixture exercises.
const CONTENT_1: MatchContent = {
  id: 'content-1',
  roster: {
    contestants: ['Mica', 'Juno', 'Patch', 'Pip', 'Nova', 'Rook', 'Echo', 'Sol'],
    gladiators: [{ name: 'IRONCLAD', kit: 'warden' }, { name: 'VESPER', kit: 'specter' }],
  },
  weapons: {
    pistol: { name: 'Pistol', ammo: 48, maxAmmo: 192, cooldown: 8, damage: 10, speed: 35, life: 24, spread: [0] },
    rifle: { name: 'Rifle', ammo: 90, maxAmmo: 360, cooldown: 4, damage: 6, speed: 44, life: 28, spread: [0] },
    scattergun: { name: 'Scattergun', ammo: 24, maxAmmo: 96, cooldown: 18, damage: 7, speed: 30, life: 12, spread: [-0.18, -0.09, 0, 0.09, 0.18] },
  },
  kits: {
    warden: { name: 'Warden', color: 0xff6b70, damage: 24, cooldown: 110, skill: 'Shockwave' },
    specter: { name: 'Specter', color: 0xb39aff, damage: 19, cooldown: 150, skill: 'Pulse scan' },
    striker: { name: 'Striker', color: 0xffba62, damage: 29, cooldown: 95, skill: 'Overdrive' },
  },
  traps: {
    mine: { trigger: 65, blast: 120, damage: 45 },
    turret: { range: 650, cooldown: 35, speed: 24, damage: 12, life: 30 },
    flame: { cycle: 160, warnAt: 80, fireAt: 120, interval: 5, range: 240, cone: 0.8, damage: 6 },
    spider: { leash: 360, acquire: 240, step: 5, grapple: 150, cooldown: 50, stun: 30, damage: 10 },
  },
  durationTicks: 600 * 20,
  cellChargeTicks: 5 * 20,
  gladiatorRespawnTicks: 20 * 20,
  hazardGraceTicks: 60 * 20,
};

// Preserve the first ten players' ordering from `content-1`; F-11 adds only this third hunter.
const CONTENT_2: MatchContent = {
  ...CONTENT_1,
  id: 'content-2',
  roster: {
    ...CONTENT_1.roster,
    gladiators: [...CONTENT_1.roster.gladiators, { name: 'BLAZE', kit: 'striker' }],
  },
};

/** Return an independent, deeply frozen copy of a shipped content set. */
export function contentById(id: string): MatchContent {
  const source = id === 'content-1' ? CONTENT_1 : id === 'content-2' ? CONTENT_2 : undefined;
  if (!source) throw new RangeError(`Unknown content id: ${id}`);
  return deepFreeze(structuredClone(source));
}

/** A match's own copy of the shipped default content. */
export function defaultContent(): MatchContent {
  return contentById(CONTENT_ID);
}
