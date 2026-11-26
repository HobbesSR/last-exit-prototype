import type { Player, PlayerInput } from '../types.ts';

// The shape of a bot's intent and its temperament. Built-in bots plan in the core (`rust/core/src/tick/bots/`, 27.2
// "Core bot intent (4e)"); the TypeScript planner that once filled this retired with its tests (#1358).

export interface BotIntent {
  input: PlayerInput;
  /** A utility to activate after selecting input.slot, before movement. */
  utilitySlot?: number;
  /** Equipment to discard when pursuing a cell with a full inventory. */
  discardSlot?: number;
}

// Mixed temperaments create occasional betrayal, rather than every converging bot starting
// a deathmatch simultaneously. All bots can retaliate; roughly one third initiate disputes,
// and under `hearingResponse` follow gunfire (#685).
export const isOpportunistic = (p: Pick<Player, 'id'>): boolean => p.id.charCodeAt(p.id.length - 1) % 3 === 0;
