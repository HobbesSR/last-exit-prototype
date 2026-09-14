import { finite, integer, safeInteger } from '../numbers.ts';
import { SLOT_COUNT } from '../equipment.ts';
import type { Player, PlayerInput, SlotIndex, Tick } from '../types.ts';

/**
 * What a client may send, and the queue a tick spends it from.
 *
 * A tick consumes exactly one input. That is the whole point of the queue, and it is what makes
 * reconciliation exact: the client applies each input once to its prediction, so the server must
 * apply it once too. Coalescing could not give that. Two packets landing between two ticks merged
 * into one application while the client had already made two, and a packet arriving late left the
 * previous input applied twice against the client's one — divergence in both directions, on a large
 * fraction of ticks, indistinguishable from real correction once it reached the client.
 *
 * Latching is gone with it. One-shot presses had to survive a merge because a merge could erase
 * them; nothing is merged now, so nothing needs to be rescued.
 *
 * This is the seam a state-sync framework calls an input definition: validate, buffer per session,
 * and hand the simulation one per fixed step.
 */

/** Inputs held for a player. Beyond this the client is sending faster than the tick consumes. */
const MAX_DEPTH = 4;
/** How long a starved queue keeps repeating the last input before the player is treated as idle. */
const REPEAT_TICKS = 10;

/** Clamp and coerce one wire input. Everything absent or malformed becomes a neutral value. */
function sanitize(input: PlayerInput, seq: number): PlayerInput {
  const axis = (v: unknown) => finite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return {
    seq,
    x: axis(input.x), y: axis(input.y), aim: finite(input.aim) ? input.aim : 0,
    attack: input.attack === true, skill: input.skill === true, interact: input.interact === true,
    drop: input.drop === true, sneak: input.sneak === true,
    slot: integer(input.slot) && input.slot >= 0 && input.slot < SLOT_COUNT ? input.slot as SlotIndex : undefined,
    moveSlot: input.moveSlot && integer(input.moveSlot.from) && integer(input.moveSlot.to)
      && input.moveSlot.from >= 0 && input.moveSlot.from < SLOT_COUNT && input.moveSlot.to >= 0 && input.moveSlot.to < SLOT_COUNT
      ? { from: input.moveSlot.from, to: input.moveSlot.to } : undefined,
  };
}

/**
 * Queue one client input, or reject it.
 *
 * `receivedSeq` guards ordering and duplicates on arrival; `lastSeq` separately records what a tick
 * has actually spent, and it is `lastSeq` the client reconciles against. Conflating the two is the
 * bug this split exists to prevent: acknowledging on arrival tells the client an input was applied
 * when it is still sitting in the queue.
 */
export function queueInput(p: Player, input: PlayerInput | null | undefined, tick: Tick): PlayerInput | null {
  if (!input || !safeInteger(input.seq) || input.seq <= (p.receivedSeq ?? -1)) return null;
  p.receivedSeq = input.seq;
  p.inputQueue ??= [];
  p.inputQueue.push(sanitize(input, input.seq));
  // A client sending faster than the tick consumes would otherwise build unbounded input lag. The
  // oldest goes, because the newest is the closest to what the player currently intends.
  while (p.inputQueue.length > MAX_DEPTH) p.inputQueue.shift();
  p.inputTick = tick;
  return p.inputQueue[p.inputQueue.length - 1]!;
}

/**
 * The one input this tick spends, and the bookkeeping that goes with spending it.
 *
 * An empty queue repeats the last input for a short while rather than stopping the player dead,
 * because a single late packet is far more common than a player genuinely releasing every key. The
 * repeat is recorded so the client can tell a correction it could not have predicted from one it
 * mispredicted, and so the depth can be tuned against real traffic rather than guessed at.
 */
export function consumeInput(p: Player, tick: Tick): PlayerInput {
  const queued = p.inputQueue?.shift();
  if (queued) {
    p.lastSeq = queued.seq ?? p.lastSeq;
    p.input = queued;
    p.inputStalled = 0;
    return queued;
  }
  p.inputStalled = (p.inputStalled ?? 0) + 1;
  if (p.inputStalled > REPEAT_TICKS || tick - (p.inputTick ?? 0) > REPEAT_TICKS) { p.input = {}; return p.input; }
  // A repeat re-applies movement and aim only. Re-firing a one-shot press would let one packet
  // loss spend a charge, open a door or throw an attack the player never asked for twice.
  const held = p.input;
  return { x: held.x, y: held.y, aim: held.aim, sneak: held.sneak, seq: held.seq };
}

/** Start a player on an empty queue. A join or resume must not spend the previous occupant's input. */
export function resetInput(p: Player): void {
  p.input = {}; p.lastSeq = -1; p.receivedSeq = -1; p.inputQueue = []; p.inputStalled = 0;
}
