import { safeInteger } from '../numbers.ts';
import { MAX_INPUT_LEAD_TICKS, inputLeadFrom, resetInput, sanitizeInput } from './input.ts';
import { viewLagFrom } from './rewind.ts';
import { emptyInput } from './tick-codec.ts';
import type { Command, DropSlot, Inbound, Input, Point } from './tick-codec.ts';
import type { MatchIds, TickMatch } from './tick-match.ts';
import type { BotIntent } from './bots.ts';
import type { Game, Player, PlayerId, PlayerInput, Tick } from '../types.ts';

// The receive boundary of the new tick (docs/27.2 "Node adapter (3d.2)"): what arrives between ticks becomes the inbound
// queue's rows. Player input keeps 24's stamped-input contract: sequence order on arrival, a stamp no earlier than the
// next tick and no further ahead than the measured lead, and a newer input superseding what is queued for its tick or
// later. The core holds the queue, so the buffer here is gone: it spends the newest sequence queued for a tick and never
// one at or below the last it spent (`Match::commands`), which is that supersession. Measured lag, lead, joins, leaves
// and dev teleports become observation rows. Bot intent becomes `CommandSource::Bot` rows. Nothing here writes the
// mirror's simulation state; acknowledgment comes back from the match after each step (`tick-mirror.ts`).

/** Unstamped inputs a player may have queued ahead, as the old buffer's depth (`input.ts`). */
const MAX_UNSTAMPED = 4;

/** The next tick an unstamped in-process input is given, per player. */
const unstamped = new WeakMap<Player, Tick>();

/** A station's number for a transit nomination, or null for one the map does not have. */
function station(ids: MatchIds, id: string | undefined): number | null {
  return id === undefined ? null : ids.transitIndex.get(id as never) ?? null;
}

/**
 * A sanitized client input as the core's `Input`. A drop is the selected slot's; the nominated target arrives with 3d.3's
 * wire field, and a utility is used by attacking with it selected.
 */
export function inputOf(ids: MatchIds, input: PlayerInput): Input {
  return { ...emptyInput(), movement: [input.x ?? 0, input.y ?? 0], aim: input.aim ?? null, sneak: input.sneak === true,
    attack: input.attack === true, skill: input.skill === true, interact: input.interact === true,
    slot: input.slot ?? null, moveSlot: input.moveSlot ? [input.moveSlot.from, input.moveSlot.to] : null,
    drop: input.drop ? { kind: 'selected' } : null, reload: input.reload === true,
    dropAmmo: input.dropAmmo ? { family: input.dropAmmo.family, count: input.dropAmmo.count } : null,
    transit: station(ids, input.transit) };
}

/** What `receive` admitted: the command row and its stamped tick, or null for an input refused on arrival. */
export interface Received { row: Inbound; tick: Tick; input: PlayerInput }

/**
 * Admit one client input for player `p`, or refuse it, with the game at tick `tick` (the next to run is `tick + 1`). The
 * rules are `queueInput`'s (24): a sequence at or below the last received is refused, and so is a stamp before the next
 * tick or beyond the player's lead. The margin is gathered for the client's clock as before. An unstamped input, from an
 * in-process caller, takes the tick after the last one so given, up to the old buffer's depth ahead, so a burst is spent
 * one per tick in arrival order.
 */
export function receive(ids: MatchIds, p: Player, input: PlayerInput | null | undefined, tick: Tick): Received | null {
  if (!input || !safeInteger(input.seq) || input.seq <= (p.receivedSeq ?? -1)) return null;
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) return null;
  p.receivedSeq = input.seq;
  const accepted = sanitizeInput(input, input.seq);
  let stamp = accepted.tick;
  if (stamp === undefined) {
    stamp = Math.max(tick + 1, (unstamped.get(p) ?? 0) + 1);
    if (stamp > tick + MAX_UNSTAMPED) stamp = tick + MAX_UNSTAMPED;
    unstamped.set(p, stamp);
  } else {
    const margin = stamp - (tick + 1);
    p.inputMarginNext = Math.min(p.inputMarginNext ?? margin, margin);
    if (margin < 0 || margin > (p.inputLeadTicks ?? MAX_INPUT_LEAD_TICKS)) return null;
  }
  p.inputTick = tick;
  return { tick: stamp, input: accepted,
    row: { type: 'command', command: { actor, source: 'player', tick: stamp, seq: accepted.seq!, input: inputOf(ids, accepted) } } };
}

/** The margin a tick reports: that of the inputs that arrived before it (`consumeInput`'s first step). */
export function rollMargin(p: Player): void {
  if (p.inputMarginNext !== undefined) { p.inputMargin = p.inputMarginNext; delete p.inputMarginNext; }
  else if (p.inputMargin !== undefined) delete p.inputMargin;
}

/**
 * A measured round trip as observation rows: the view lag the core rewinds by and the input lead this boundary admits
 * by. Only a change is a row, as `setViewLag` records it. The lead stays here (27.2 "Output (3c)"); the lag is the core's,
 * and reaches the mirror through the change list.
 */
export function measured(ids: MatchIds, p: Player, roundTripMs: number | null | undefined): Inbound[] {
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) return [];
  const lag = viewLagFrom(roundTripMs), lead = roundTripMs != null ? inputLeadFrom(roundTripMs) : 0;
  const rows: Inbound[] = [];
  if (lag !== (p.viewLagTicks ?? 0)) rows.push({ type: 'observation', observation: { kind: 'viewLag', actor, ticks: lag } });
  if (lead !== (p.inputLeadTicks ?? 0)) rows.push({ type: 'observation', observation: { kind: 'inputLead', actor, ticks: lead } });
  if (lead > 0) p.inputLeadTicks = lead; else delete p.inputLeadTicks;
  return rows;
}

/**
 * A connection taking over its seat (`resume`) or handing it to a bot (`leave`). The receive state starts over, as
 * `resetInput` leaves it, and the core clears the held input, lag and spent sequence on the row.
 */
export function seatChanged(ids: MatchIds, p: Player, kind: 'join' | 'leave'): Inbound | null {
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) return null;
  resetInput(p);
  unstamped.delete(p);
  // As `resume` and `leave` set it: the core's record agrees at the tick's intake, and no bot command is sent meanwhile.
  p.bot = kind === 'leave';
  return { type: 'observation', observation: { kind, actor } };
}

/** A dev teleport of a player's body (24). The core warps it before T's solve and marks the frame. */
export function teleported(ids: MatchIds, id: PlayerId, to: Point): Inbound | null {
  const actor = ids.actorOfPlayer.get(id);
  return actor === undefined ? null : { type: 'observation', observation: { kind: 'teleport', body: { kind: 'actor', id: actor }, to } };
}

/**
 * A bot's intent as its command for tick `tick` (R11: read from the mirror as T−1 left it). `utilitySlot` is the core's
 * own field. `discardSlot`, equipment dropped to make room for a cell, is a drop of that slot, which outranks a drop of the
 * selected one (R1 allows one). A transit nomination is sent only under `transit: 'selectable'` content, where the old
 * rules read it. The sequence is one past the last the match spent for the actor, so a seat handed back from a player
 * keeps spending.
 */
export function botCommand(s: Game, match: TickMatch, p: Player, intent: BotIntent, tick: Tick): Command {
  const ids = match.ids, actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) throw new RangeError(`tick-boundary: no actor for ${p.id}`);
  const input = intent.input;
  const drop: DropSlot | null = intent.discardSlot !== undefined ? { kind: 'slot', slot: intent.discardSlot }
    : input.drop ? { kind: 'selected' } : null;
  return { actor, source: 'bot', tick, seq: (match.acknowledged(p.id) ?? -1) + 1,
    input: { ...inputOf(ids, { ...input, transit: s.content.transit === 'selectable' ? input.transit : undefined }),
      utilitySlot: intent.utilitySlot ?? null, drop } };
}

/**
 * The receive boundary bound to one match: each call admits what it can and submits the rows. It is the new path's
 * `acceptInput`, `setViewLag`, `resume`, `leave` and `teleport`, and returns what each would record.
 */
export class TickBoundary {
  readonly s: Game;
  readonly match: TickMatch;
  constructor(s: Game, match: TickMatch) { this.s = s; this.match = match; }
  #player(id: PlayerId): Player | undefined { return this.s.players.find(p => p.id === id); }
  #submit(tick: Tick, rows: readonly Inbound[]): boolean { return rows.length === 0 || this.match.submit(tick, rows).every(Boolean); }
  /** Admit a client input; the input as admitted, or null when refused here or by the match. */
  input(id: PlayerId, input: PlayerInput): PlayerInput | null {
    const p = this.#player(id);
    const received = p && receive(this.match.ids, p, input, this.s.tick);
    return received && this.#submit(received.tick, [received.row]) ? received.input : null;
  }
  /** A measured round trip: the observation rows submitted for the next tick, or null for no such player. */
  roundTrip(id: PlayerId, roundTripMs: number | null | undefined): Inbound[] | null {
    const p = this.#player(id);
    if (!p) return null;
    const rows = measured(this.match.ids, p, roundTripMs);
    this.#submit(this.s.tick + 1, rows);
    return rows;
  }
  seat(id: PlayerId, kind: 'join' | 'leave'): Inbound | null {
    const p = this.#player(id), row = p && seatChanged(this.match.ids, p, kind);
    if (row) this.#submit(this.s.tick + 1, [row]);
    return row ?? null;
  }
  teleport(id: PlayerId, to: Point): Inbound | null {
    const row = teleported(this.match.ids, id, to);
    if (row) this.#submit(this.s.tick + 1, [row]);
    return row;
  }
}
