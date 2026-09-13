
import type { Kit, KitSpec, Tick } from '../types.ts';

export const VERSION = 'last-exit-0.6';
export const HZ = 20;
export const DURATION: Tick = 600 * HZ;
export const CELL_CHARGE_TICKS: Tick = 5 * HZ;
export const GLADIATOR_RESPAWN_TICKS: Tick = 20 * HZ;
export const HAZARD_GRACE_TICKS: Tick = 60 * HZ;
export const KITS: Record<Kit, KitSpec> = {
  warden: { name: 'Warden', color: 0xff6b70, damage: 24, cooldown: 110, skill: 'Shockwave' },
  specter: { name: 'Specter', color: 0xb39aff, damage: 19, cooldown: 150, skill: 'Pulse scan' },
  striker: { name: 'Striker', color: 0xffba62, damage: 29, cooldown: 95, skill: 'Overdrive' },
};
