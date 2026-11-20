import type { Game, GroundItem, PlayerInput } from '../types.ts';

/** Utility amounts shared by the core rules and pure previews. */
export const UTILITY_RULES = Object.freeze({ medHealth: 40, shieldAmount: 30, maxShield: 75 });

/** Phase 2's collected action, consumed in phase 3's stable actor order. */
export interface ActionIntent {
  input: PlayerInput;
  /** A utility to activate after selecting input.slot, before movement. */
  utilitySlot?: number;
  /** Equipment to discard when pursuing a cell with a full inventory. */
  discardSlot?: number;
}

/** A complete drop whose identities and counters are still in a transaction. */
export interface DropPlan { records: GroundItem[]; itemSerial: number; scatterSerial: number; allocation: Game }
