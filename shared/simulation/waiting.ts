import { movePlayer, canOccupy, bodyRadius } from '../movement.ts';
import { queueInput, consumeInput, resetInput } from './input.ts';
import { makePlayer } from './state.ts';
import { observed } from './visibility.ts';
import { ownPlayerFields } from './projection-contract.ts';
import type { GameMap, Kit, Player, PlayerId, PlayerInput, Role, Tick } from '../types.ts';

/**
 * Where people wait before a match starts (#236, 22.5): a small simulation of its own that the room runs
 * until the start. Movement only. Nobody can be harmed and there are no bots. It shares no state, IDs or
 * randomness with the match and is never recorded, so the match, its recording and the fixture are the
 * same with or without it. At the start everyone moves to the match's own spawns.
 */

/** A waiting area: a map with no exit, entry or objectives, since nothing happens there but walking. */
export type WaitingMap = Omit<GameMap, 'exit' | 'entry'>;

export interface Waiting {
  tick: Tick;
  map: WaitingMap;
  /** People only, in arrival order. */
  players: Player[];
  /** How many have arrived so far, which picks the next arrival point. */
  arrivals: number;
}

export function createWaiting(map: WaitingMap): Waiting {
  return { tick: 0, map, players: [], arrivals: 0 };
}

/**
 * Bring someone into the waiting area, or show a change of role, kit or name on someone already there.
 * Someone already there keeps where they stand, unless a bigger body no longer fits there.
 */
export function enterWaiting(w: Waiting, id: PlayerId, role: Role, kit: Kit, name: string): Player {
  const old = w.players.find(p => p.id === id);
  const p = makePlayer(id, name.slice(0, 16), role, kit, 0);
  p.bot = false; resetInput(p);
  const arrival = () => w.map.spawns[w.arrivals++ % w.map.spawns.length]!;
  const at = old && canOccupy(w.map, old.x, old.y, bodyRadius(p)) ? old : arrival();
  p.x = at.x; p.y = at.y;
  if (old) {
    // The queue and its sequence numbers are the same person's, so prediction carries on undisturbed.
    Object.assign(p, { heading: old.heading, input: old.input, lastSeq: old.lastSeq, receivedSeq: old.receivedSeq, inputQueue: old.inputQueue, inputTick: old.inputTick, inputStalled: old.inputStalled });
    w.players[w.players.indexOf(old)] = p;
  } else w.players.push(p);
  return p;
}

export function leaveWaiting(w: Waiting, id: PlayerId): void {
  w.players = w.players.filter(p => p.id !== id);
}

/** Queue one input from someone waiting; false when it is refused. Only movement and aim are read. */
export function waitingInput(w: Waiting, id: PlayerId, input: PlayerInput | null | undefined): boolean {
  const p = w.players.find(p => p.id === id);
  return !!p && !!queueInput(p, input, w.tick);
}

/** One tick: everyone spends one input, as in a match, and walks. Nothing else happens. */
export function stepWaiting(w: Waiting): void {
  w.tick++;
  for (const p of w.players) {
    const input = consumeInput(p, w.tick);
    p.heading = input.aim || 0;
    movePlayer(w.map, p, input);
  }
}

/**
 * What one person waiting is sent: everyone there, since the yard is small and the lobby already lists
 * them, in the frame shape a match's player view has, with nothing to pick up or dodge. Others are
 * described by the same fields a match shows of a player in sight.
 */
export function waitingView(w: Waiting, id: PlayerId) {
  return {
    tick: w.tick, phase: 'waiting' as const, directed: false,
    players: w.players.map(p => p.id === id ? ownPlayerFields(p) : observed(p)),
    items: [], gates: [], traps: [], projectiles: [], effects: [], events: []
  };
}
