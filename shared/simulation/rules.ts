import { defaultContent } from './content.ts';
import type { Kit, KitSpec, Role, Tick } from '../types.ts';

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

// Standalone defaults for callers without a match. A live match reads its own pinned content
// instead; these are detached copies of the shipped set (22.7), so editing one changes neither the
// retained content literals nor any match already created.
const shipped = defaultContent();
export const DURATION: Tick = shipped.durationTicks;
export const CELL_CHARGE_TICKS: Tick = shipped.cellChargeTicks;
export const GLADIATOR_RESPAWN_TICKS: Tick = shipped.gladiatorRespawnTicks;
export const HAZARD_GRACE_TICKS: Tick = shipped.hazardGraceTicks;
export const KITS: Record<Kit, KitSpec> = structuredClone(shipped.kits);

// Interaction reaches, compared strictly (`distance < reach`). Charging and transit share a value but
// are separate policies.
export const GATE_REACH = 85;
export const EXTRACTION_REACH = 65;
export const CHARGE_REACH = 70;
export const PICKUP_REACH = 45;
export const TRANSIT_REACH = 70;

// Where a gladiator may respawn: strictly beyond the hazard by the margin, strictly farther than the
// distance from every active contestant, and with room for this radius. The radius is its own rule,
// wider than the 23-unit gladiator body.
export const RESPAWN_HAZARD_MARGIN = 400;
export const RESPAWN_CONTESTANT_DISTANCE = 1000;
export const RESPAWN_CLEARANCE_RADIUS = 25;

/** A player's name is cut to this many UTF-16 code units. */
export const MAX_PLAYER_NAME = 16;
/** Roles in roster and identifier order. */
export const ROLES: readonly Role[] = ['contestant', 'gladiator'];
/** The kit preferred when none is chosen; content must still offer it. */
export const DEFAULT_KIT: Kit = 'warden';
/** Escape pods a match starts with. A rule, not a roster capacity or a content field. */
export const INITIAL_ESCAPE_SLOTS = 3;
