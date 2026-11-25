import { finite } from '../numbers.ts';
import { inputLeadFrom, queueInput, queueSanitizedInput, resetInput, takeQueued } from './input.ts';
import type { SanitizedInput } from './input.ts';
import { playerById } from './relations.ts';
import { viewLagFrom } from './rewind.ts';
import { emptyInput } from './tick-codec.ts';
import { botLabel } from './tick-match.ts';
import { wireIds } from './wire-ids.ts';
import type { Command, DropSlot, Inbound, Input, Point, Target } from './tick-codec.ts';
import type { WireIds } from './wire-ids.ts';
import type { MatchIds, TickMatch } from './tick-match.ts';
import type { BotIntent } from './bots.ts';
import type { Game, InputTarget, Kit, Player, PlayerId, PlayerInput, Tick } from '../types.ts';

// The receive boundary of the new tick (docs/27.2 "Node adapter (3d.2)"): what arrives between ticks becomes the inbound
// queue's rows. Player input keeps 24's stamped-input contract by keeping its buffer: `queueInput` admits on sequence,
// stamp and lead, gathers the margin, supersedes what is queued for the new stamp's tick or later, and holds unstamped
// input first in, first out to its depth. Only the input the next tick spends leaves the buffer (`takeQueued`), as that
// tick's command row, so a seat change, a supersession or an overflow never meets a row already in the core. The core
// spends, holds and acknowledges. Measured lag, lead, joins, leaves and dev teleports become observation rows. Bot intent
// becomes `CommandSource::Bot` rows. Acknowledgment comes back from the match after each step (`tick-mirror.ts`).

/** The view lag last reported per player, queued or committed, which a new measurement is compared with. */
const reportedLag = new WeakMap<Player, Tick>();

/** A station's number for a transit nomination, or null for one the map does not have. */
function station(ids: MatchIds, id: string | undefined): number | null {
  return id === undefined ? null : ids.transitIndex.get(id as never) ?? null;
}

/**
 * The core's target for a nominated one, or null for one that names nothing on this map. A gate is its slot, a station its
 * charger or transit index, and an item its internal ID through the match's wire key.
 */
export function targetOf(ids: MatchIds, t: InputTarget, wire: WireIds): Target | null {
  switch (t.kind) {
    case 'extraction': return t;
    case 'gate': return t.gateIdx < ids.gateIds.length ? { kind: 'gate', id: t.gateIdx } : null;
    case 'station': {
      const index = ids.chargerIndex.get(t.id as never) ?? ids.transitIndex.get(t.id as never);
      return index === undefined ? null : { kind: 'station', id: index };
    }
    case 'item': {
      let id: number;
      try { id = wire.internal(t.id, 'item'); } catch { return null; }
      return Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff ? { kind: 'item', id } : null;
    }
    case 'unresolved': return null;
  }
}

/**
 * A sanitized client input as the core's `Input`. A drop is the selected slot's, and a utility is used by attacking with
 * it selected. A nomination that failed, malformed (the sanitizer's `unresolved`) or naming nothing on the map, reaches
 * the core as `unresolved`: R8 allows no other gesture, so any rail destination goes, and the core rejects a pressed
 * interact with it (review 1049). Movement and combat stand.
 */
export function inputOf(ids: MatchIds, input: PlayerInput, wire: WireIds = wireIds(), selectableTransit = true): Input {
  const mapped = input.target ? targetOf(ids, input.target, wire) : null, failed = input.target !== undefined && mapped === null;
  const pressed = input.interact === true || input.target?.kind === 'unresolved';
  const transit = selectableTransit && !failed ? station(ids, input.transit) : null;
  // An explicit unknown station must not fall through to a local interact.
  const unknownStation = selectableTransit && input.transit !== undefined && transit === null && !failed;
  // A drag into the world names the source slot on the same input as drop.
  const dropSlot = input.drop ? input.slot : undefined;
  const drop: DropSlot | null = dropSlot !== undefined ? { kind: 'slot', slot: dropSlot } : input.drop ? { kind: 'selected' } : null;
  return { ...emptyInput(), movement: [input.x ?? 0, input.y ?? 0], aim: input.aim ?? null, sneak: input.sneak === true,
    attack: input.attack === true, skill: input.skill === true, interact: pressed && !unknownStation, target: failed ? { kind: 'unresolved' } : mapped,
    slot: dropSlot === undefined ? input.slot ?? null : null, moveSlot: input.moveSlot ? [input.moveSlot.from, input.moveSlot.to] : null,
    drop, reload: input.reload === true,
    dropAmmo: input.dropAmmo ? { family: input.dropAmmo.family, count: input.dropAmmo.count } : null,
    transit };
}

/**
 * The command row of the input player `p` spends at `tick`, if one is buffered for it: a stamp for that tick or the oldest
 * unstamped input, as `consumeInput` takes it.
 */
export function dueCommand(ids: MatchIds, p: Player, tick: Tick, wire: WireIds = wireIds(), selectableTransit = true): Inbound | null {
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) return null;
  const input = takeQueued(p, tick);
  if (!input) return null;
  const mapped = inputOf(ids, input, wire, selectableTransit);
  return { type: 'command', command: { actor, source: 'player', tick, seq: input.seq!, input: mapped } };
}

/** The margin a tick reports: that of the inputs that arrived before it (`consumeInput`'s first step). */
export function rollMargin(p: Player): void {
  if (p.inputMarginNext !== undefined) { p.inputMargin = p.inputMarginNext; delete p.inputMarginNext; }
  else if (p.inputMargin !== undefined) delete p.inputMargin;
}

/**
 * A measured round trip as observation rows: the view lag the core rewinds by and the input lead this boundary admits
 * by. Only a change from the last report is a row, as `setViewLag` records it. The lead stays here (27.2 "Output (3c)");
 * the lag is the core's, and reaches the mirror through the change list.
 */
export function measured(ids: MatchIds, p: Player, roundTripMs: number | null | undefined): Inbound[] {
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) return [];
  const lag = viewLagFrom(roundTripMs), lead = roundTripMs != null ? inputLeadFrom(roundTripMs) : 0;
  const rows: Inbound[] = [];
  // Compared with the last lag reported, queued or not, so a correction before the next tick is never lost.
  if (lag !== (reportedLag.get(p) ?? p.viewLagTicks ?? 0)) rows.push({ type: 'observation', observation: { kind: 'viewLag', actor, ticks: lag } });
  reportedLag.set(p, lag);
  if (lead !== (p.inputLeadTicks ?? 0)) rows.push({ type: 'observation', observation: { kind: 'inputLead', actor, ticks: lead } });
  if (lead > 0) p.inputLeadTicks = lead; else delete p.inputLeadTicks;
  return rows;
}

/**
 * A connection taking over its seat (`resume`) or handing it to a bot (`leave`). The receive state and the buffer start
 * over, as `resetInput` leaves them, so nothing the previous connection queued is ever spent; the core clears the held
 * input, lag and spent sequence on the row. A relabel carries its rank just after binding the new label.
 * The rank is relative to this observation, so another relabel queued for the same tick leaves it intact.
 */
export function seatChanged(ids: MatchIds, p: Player, kind: 'join' | 'leave', kit?: Kit, relabeled = false): Inbound | null {
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) return null;
  resetInput(p);
  reportedLag.set(p, 0);
  // As `resume` and `leave` set it: the core's record agrees at the tick's intake, and no bot command is sent meanwhile.
  p.bot = kind === 'leave';
  return { type: 'observation', observation: kind === 'join'
    ? { kind, actor, ...(kit === undefined ? {} : { kit }), ...(relabeled ? { botLabel: botLabel(ids.playerOfActor.values(), p.id) } : {}) }
    : { kind, actor } };
}

/**
 * A dev teleport of an active player's body (24), to the rounded point as the old operation took it. The core refuses a
 * point the body could not stand on (`Match::teleport_clear`), warps it before T's solve otherwise, and marks the frame.
 */
export function teleported(ids: MatchIds, p: Player, to: Point): Inbound | null {
  const actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined || p.status !== 'active' || !finite(to[0]) || !finite(to[1])) return null;
  return { type: 'observation', observation: { kind: 'teleport', body: { kind: 'actor', id: actor }, to: [Math.round(to[0]), Math.round(to[1])] } };
}

/**
 * Encode a JS reference-planner intent for adapter tests. `utilitySlot` is the core's
 * own field. `discardSlot`, equipment dropped to make room for a cell, is a drop of that slot, which outranks a drop of the
 * selected one (R1 allows one). A transit nomination is sent only under `transit: 'selectable'` content, where the old
 * rules read it. The sequence is one past the last the match spent for the actor, so a seat handed back from a player
 * keeps spending.
 */
export function botCommand(s: Game, match: TickMatch, p: Player, intent: BotIntent, tick: Tick): Command {
  const ids = match.ids, actor = ids.actorOfPlayer.get(p.id);
  if (actor === undefined) throw new RangeError(`tick-boundary: no actor for ${p.id}`);
  const input = intent.input;
  // The planner names its preferred slot every tick. Only a change spends R1's slot action.
  const slot = input.slot === p.selectedSlot ? undefined : input.slot;
  const drop: DropSlot | null = intent.discardSlot !== undefined ? { kind: 'slot', slot: intent.discardSlot }
    : input.drop ? { kind: 'selected' } : null;
  return { actor, source: 'bot', tick, seq: (match.acknowledged(p.id) ?? -1) + 1,
    input: { ...inputOf(ids, { ...input, slot, drop: false }, undefined, s.content.transit === 'selectable'),
      utilitySlot: intent.utilitySlot ?? null, drop } };
}

/**
 * The receive boundary bound to one match. It is the new path's `acceptInput`, `setViewLag`, `resume`, `leave` and
 * `teleport`, and returns what each would record. Observations are submitted for the next tick as they arrive; player
 * input waits in its buffer until `due` takes it for the tick about to run.
 */
export class TickBoundary {
  readonly s: Game;
  readonly match: TickMatch;
  /** The match's outward ID mapping (#1164), which a nominated item's ID arrives through. */
  readonly wire: WireIds;
  constructor(s: Game, match: TickMatch, wire: WireIds = wireIds()) { this.s = s; this.match = match; this.wire = wire; }
  #player(id: PlayerId): Player | undefined { return playerById(this.s, id); }
  #observe(rows: readonly Inbound[]): void {
    if (rows.length && !this.match.submit(this.s.tick + 1, rows).every(Boolean)) throw new Error('tick-boundary: the match refused an observation');
  }
  /** Buffer a client input; the input as admitted, or null when refused on arrival. */
  input(id: PlayerId, input: PlayerInput): PlayerInput | null {
    const p = this.#player(id);
    return p && this.match.ids.actorOfPlayer.has(p.id) ? queueInput(p, input, this.s.tick) : null;
  }
  /** Transport already sanitized these fields before dispatch. */
  sanitizedInput(id: PlayerId, input: SanitizedInput): PlayerInput | null {
    const p = this.#player(id);
    return p && this.match.ids.actorOfPlayer.has(p.id) ? queueSanitizedInput(p, input, this.s.tick) : null;
  }
  /**
   * The command rows for `tick`: what each active player's buffer holds for it. A bot's seat has no buffer, and an inactive
   * player's waits, as the old tick spent only active players' input (R2 discards what is then past).
   */
  due(tick: Tick): Inbound[] {
    const rows: Inbound[] = [];
    for (const p of this.s.players) {
      if (p.bot || p.status !== 'active') continue;
      const row = dueCommand(this.match.ids, p, tick, this.wire, this.s.content.transit === 'selectable');
      if (row) rows.push(row);
    }
    return rows;
  }
  /** A measured round trip: the observation rows submitted for the next tick, or null for no such player. */
  roundTrip(id: PlayerId, roundTripMs: number | null | undefined): Inbound[] | null {
    const p = this.#player(id);
    if (!p) return null;
    const rows = measured(this.match.ids, p, roundTripMs);
    this.#observe(rows);
    return rows;
  }
  seat(id: PlayerId, kind: 'join' | 'leave', kit?: Kit, relabeled = false): Inbound | null {
    const p = this.#player(id), row = p ? seatChanged(this.match.ids, p, kind, kit, relabeled) : null;
    if (row) this.#observe([row]);
    return row;
  }
  teleport(id: PlayerId, to: Point): Inbound | null {
    const p = this.#player(id), row = p ? teleported(this.match.ids, p, to) : null;
    if (row) this.#observe([row]);
    return row;
  }
}
