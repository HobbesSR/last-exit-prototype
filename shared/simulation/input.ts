import { finite, integer, safeInteger } from '../numbers.ts';
import { SLOT_COUNT, isAmmoFamily } from '../equipment.ts';
import { HZ } from './rules.ts';
import type { Player, PlayerInput, SlotIndex, StationId, Tick } from '../types.ts';

/**
 * What a client may send, and the buffer a tick spends it from.
 *
 * A tick consumes at most one input. That is what makes reconciliation exact: the client applies
 * each input once to its prediction, so the server must apply it once too. Coalescing could not
 * give that. Two packets landing between two ticks merged into one application while the client had
 * already made two, and a packet arriving late left the previous input applied twice against the
 * client's one — divergence in both directions, indistinguishable from real correction.
 *
 * A client input names the tick it is for (#1096, 24). The buffer holds it until that tick and the
 * tick spends it then, so how long the network took no longer decides when an input lands: the
 * client's clock does (`shared/input-clock.ts`). An input that arrives after its tick has run is
 * late and is discarded. Nothing is rewound for movement; only hits are judged in the past
 * (`rewind.ts`). A stamp too far ahead is refused, and how far is too far comes from the round trip
 * the server measured, never from the client. Each arrival reports its margin — how many ticks
 * early it was — and the client steers its send rate by that.
 *
 * An input without a stamp is spent on the next tick, in arrival order, as all input was before
 * stamps. Only in-process callers (tests, tools, scenario scripts) send one: the wire requires a
 * stamp (`shared/protocol.ts`). The two are not mixed for one player.
 *
 * This is the seam a state-sync framework calls an input definition: validate, buffer per session,
 * and hand the simulation one per fixed step.
 */

/** Unstamped inputs held for a player. Beyond this the sender is outrunning the tick. */
const MAX_DEPTH = 4;
/** How long a starved buffer keeps repeating the last input before the player is treated as idle. Prediction mirrors it. */
export const REPEAT_TICKS = 10;
/** Bounds an ammo-drop request; the simulation then drops at most what the reserve holds. */
const MAX_AMMO_DROP = 9999;
/** Bounds a named id, such as a transit destination. */
const MAX_ID = 64;
const TICK_MS = 1000 / HZ;
/** The lead every connection gets before its round trip is added: jitter and the client's target margin. */
const BASE_LEAD_TICKS = 4;
/** The largest round trip the server measures (`MAX_RTT_MS`, `server/latency.js`). */
const MAX_MEASURED_RTT_MS = 400;
/** Round trips of lead granted on top of the base. */
const LEAD_ROUND_TRIPS = 3;
/** The lead for a connection with no measurement yet, and the most any measurement grants (1.4 s). */
export const MAX_INPUT_LEAD_TICKS = BASE_LEAD_TICKS + LEAD_ROUND_TRIPS * Math.ceil(MAX_MEASURED_RTT_MS / TICK_MS);

/**
 * How many ticks ahead of the next tick a player's stamp may be, from a round trip the server
 * measured itself, or the most it grants while there is none.
 *
 * Three round trips. A reliable socket that loses a packet holds everything behind it for about one
 * and a half (42.48), and a lossy link keeps the client's clock well ahead to ride that out; at two,
 * a poor link's stamps overran the bound 2–5% of the time, at three 0.1–0.2% (42.48, R). A lead buys
 * a client nothing but its own delay, so this bounds the buffer rather than a cheat; a claimed past
 * is never honoured at all.
 */
export function inputLeadFrom(roundTripMs: number | null | undefined): number {
  if (!finite(roundTripMs) || roundTripMs < 0) return MAX_INPUT_LEAD_TICKS;
  return Math.min(MAX_INPUT_LEAD_TICKS, BASE_LEAD_TICKS + LEAD_ROUND_TRIPS * Math.ceil(roundTripMs / TICK_MS));
}

/** Clamp and coerce one wire input. Everything absent or malformed becomes a neutral value. */
export function sanitizeInput(input: PlayerInput, seq: number): PlayerInput {
  const axis = (v: unknown) => finite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return {
    seq,
    // Present only when stamped, so unstamped inputs keep their recorded shape.
    ...(safeInteger(input.tick) && input.tick >= 0 ? { tick: input.tick } : {}),
    x: axis(input.x), y: axis(input.y), aim: finite(input.aim) ? input.aim : 0,
    attack: input.attack === true, skill: input.skill === true, interact: input.interact === true,
    drop: input.drop === true, sneak: input.sneak === true,
    slot: integer(input.slot) && input.slot >= 0 && input.slot < SLOT_COUNT ? input.slot as SlotIndex : undefined,
    moveSlot: input.moveSlot && integer(input.moveSlot.from) && integer(input.moveSlot.to)
      && input.moveSlot.from >= 0 && input.moveSlot.from < SLOT_COUNT && input.moveSlot.to >= 0 && input.moveSlot.to < SLOT_COUNT
      ? { from: input.moveSlot.from, to: input.moveSlot.to } : undefined,
    // Added only when sent, so inputs without L2 commands keep their recorded shape.
    ...(input.reload === true ? { reload: true as const } : {}),
    ...(input.dropAmmo && isAmmoFamily(input.dropAmmo.family) && safeInteger(input.dropAmmo.count) && input.dropAmmo.count > 0 && input.dropAmmo.count <= MAX_AMMO_DROP
      ? { dropAmmo: { family: input.dropAmmo.family, count: input.dropAmmo.count } } : {}),
    // A station id is checked against the map when spent; here only its size is bounded.
    ...(typeof input.transit === 'string' && input.transit.length > 0 && input.transit.length <= MAX_ID ? { transit: input.transit as StationId } : {}),
  };
}

/**
 * Buffer one client input, or refuse it. `tick` is the last tick run; the next to run is `tick + 1`.
 *
 * `receivedSeq` guards ordering and duplicates on arrival; `lastSeq` separately records what a tick
 * has actually spent. Acknowledging on arrival would tell the client an input was applied while it
 * is still waiting for its tick.
 *
 * Returns the input as buffered, or null when it is refused: out of order, late, or too far ahead.
 * A refused input never reaches the simulation, so it is not recorded either.
 */
export function queueInput(p: Player, input: PlayerInput | null | undefined, tick: Tick): PlayerInput | null {
  if (!input || !safeInteger(input.seq) || input.seq <= (p.receivedSeq ?? -1)) return null;
  p.receivedSeq = input.seq;
  p.inputQueue ??= [];
  const accepted = sanitizeInput(input, input.seq);
  const stamp = accepted.tick;
  if (stamp === undefined) {
    p.inputQueue.push(accepted);
    // A sender outrunning the tick would otherwise build unbounded input lag. The oldest goes,
    // because the newest is the closest to what the player currently intends.
    while (p.inputQueue.length > MAX_DEPTH) p.inputQueue.shift();
    p.inputTick = tick;
    return accepted;
  }
  // The client steers by the worst arrival since the last tick, late ones included.
  const margin = stamp - (tick + 1);
  p.inputMarginNext = Math.min(p.inputMarginNext ?? margin, margin);
  if (margin < 0 || margin > (p.inputLeadTicks ?? MAX_INPUT_LEAD_TICKS)) return null;
  // A newer input supersedes whatever is buffered for its tick or later — a client whose clock
  // stepped back — so a tick still spends one input and spending still follows sequence order.
  p.inputQueue = p.inputQueue.filter(queued => queued.tick !== undefined && queued.tick < stamp);
  p.inputQueue.push(accepted);
  p.inputTick = tick;
  return accepted;
}

/**
 * The one input this tick spends, and the bookkeeping that goes with spending it.
 *
 * A stamped input is spent on its own tick and no other. A tick with nothing for it repeats the last
 * input for a short while rather than stopping the player dead, because a single late packet is far
 * more common than a player genuinely releasing every key. The repeat is recorded so the client can
 * tell a correction it could not have predicted from one it mispredicted.
 */
export function consumeInput(p: Player, tick: Tick): PlayerInput {
  // The margin reported with this tick is that of the inputs that arrived before it.
  if (p.inputMarginNext !== undefined) { p.inputMargin = p.inputMarginNext; delete p.inputMarginNext; }
  else if (p.inputMargin !== undefined) delete p.inputMargin;
  const queue = p.inputQueue;
  // A stamp whose tick ran without spending it (the player was not active then) is past, not owed.
  while (queue?.length && queue[0]!.tick !== undefined && queue[0]!.tick < tick) queue.shift();
  const head = queue?.[0];
  const queued = head && (head.tick === undefined || head.tick === tick) ? queue!.shift() : undefined;
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

/** Start a player on an empty buffer. A join or resume must not spend the previous occupant's input. */
export function resetInput(p: Player): void {
  p.input = {}; p.lastSeq = -1; p.receivedSeq = -1; p.inputQueue = []; p.inputStalled = 0;
  delete p.inputMargin; delete p.inputMarginNext; delete p.inputLeadTicks;
}
