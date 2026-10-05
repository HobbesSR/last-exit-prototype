
import type { Kit, KitSpec, Tick } from '../types.ts';

export const VERSION = 'last-exit-0.7';
export const HZ = 20;
/** The seeds a room accepts: whole numbers from 1 to this. */
export const MAX_ARENA_SEED = 2147483647;
export const isArenaSeed = (seed: number): boolean => Number.isInteger(seed) && seed >= 1 && seed <= MAX_ARENA_SEED;
/**
 * Ticks the client's receive buffer holds a frame before drawing it. A presentation choice that hit
 * resolution has to know about: it is part of how far behind a player's view runs when they aim.
 */
export const INTERPOLATION_DELAY_TICKS = 2;
export const DURATION: Tick = 600 * HZ;
export const CELL_CHARGE_TICKS: Tick = 5 * HZ;
export const GLADIATOR_RESPAWN_TICKS: Tick = 20 * HZ;
export const HAZARD_GRACE_TICKS: Tick = 60 * HZ;
export const KITS: Record<Kit, KitSpec> = {
  warden: { name: 'Warden', color: 0xff6b70, damage: 24, cooldown: 110, skill: 'Shockwave' },
  specter: { name: 'Specter', color: 0xb39aff, damage: 19, cooldown: 150, skill: 'Pulse scan' },
  striker: { name: 'Striker', color: 0xffba62, damage: 29, cooldown: 95, skill: 'Overdrive' },
};
