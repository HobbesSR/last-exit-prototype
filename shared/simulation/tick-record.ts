import { emptyInput } from './tick-codec.ts';
import type { BodyRef, BotLabel, Carried, Command, Inbound, Input, Observation, Target } from './tick-codec.ts';
import type { MatchIds } from './tick-match.ts';
import type { GateId, Kit, PlayerId, Tick } from '../types.ts';

// What a frame on the new tick's path records as its `commands` (docs/26 "Schema 22", 27.2 Boundary): T's inbound queue as
// the core spent it, one recorded command per row, in the queue's order, less the first-class bots' commands. The three
// kinds of row are the three recorded types: `command` (input through the receive boundary: a person's, or that of a bot
// controlling a player), `observation` (view lag, input lead, join, leave, dev teleport) and `carried` (events carried
// from T−1). The room's own commands (start, the roster's joins and choices, abandonment) are recorded beside them.
//
// A first-class bot's command (`source: 'bot'`) is the match's own computation from the history the recording holds, so
// it is derived, not recorded (Corey, 2026-11-23). A seat's `leave` and `join` observations mark where derivation starts
// and stops.
//
// Identities are the recording's: an actor is its player ID, a gate, a station or a trap its authored ID, and an item its
// item ID. A body is a label, `actor:<player>`, `item:<id>` or `prop:<authored label>`. An input field at its empty value
// is left out, so an idle bot's command is a few bytes.

type Recorded<T extends string, F> = { type: T } & F;
export type RecordedBody = string;
export type RecordedTarget = { kind: 'extraction' | 'unresolved' } | { kind: 'station' | 'gate'; id: string } | { kind: 'item'; id: number };
/** An input with its empty fields left out, and its station and target indices as authored IDs. */
export type RecordedInput = Partial<Omit<Input, 'target' | 'transit'>> & { target?: RecordedTarget; transit?: string };
export type RecordedCommand =
  | Recorded<'command', { id: PlayerId; source: Command['source']; tick: Tick; seq: number; input: RecordedInput }>
  | Recorded<'observation', { kind: 'viewLag' | 'inputLead'; id: PlayerId; ticks: Tick }>
  | Recorded<'observation', { kind: 'join'; id: PlayerId; kit?: Kit }>
  | Recorded<'observation', { kind: 'leave'; id: PlayerId }>
  | Recorded<'observation', { kind: 'teleport'; body: RecordedBody; x: number; y: number }>
  | Recorded<'carried', { kind: 'impulse'; body: RecordedBody; x: number; y: number }>
  | Recorded<'carried', { kind: 'killReward'; id: PlayerId }>
  | Recorded<'carried', { kind: 'gateObserved'; id: PlayerId; gate: string; open: boolean; locked: boolean }>;

const EMPTY = emptyInput();

/** T's inbound queue as the frame's recorded commands, without the first-class bots' commands. */
export function recordedInbound(ids: MatchIds, inbound: readonly Inbound[]): RecordedCommand[] {
  const player = (actor: number): PlayerId => {
    const id = ids.playerOfActor.get(actor);
    if (id === undefined) throw new RangeError(`tick-record: no player for actor ${actor}`);
    return id;
  };
  const body = (b: BodyRef): RecordedBody => b.kind === 'actor' ? `actor:${player(b.id)}`
    : b.kind === 'prop' ? `prop:${ids.propLabels[b.id] ?? b.id}` : `${b.kind}:${b.id}`;
  const station = (index: number): string => {
    const s = ids.stations[index];
    if (!s) throw new RangeError(`tick-record: no station ${index}`);
    return s.id;
  };
  const target = (t: Target): RecordedTarget => t.kind === 'extraction' || t.kind === 'unresolved' || t.kind === 'item' ? t
    : { kind: t.kind, id: t.kind === 'gate' ? ids.gateIds[t.id]! : station(t.id) };
  const input = (i: Input): RecordedInput => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(i) as (keyof Input)[]) {
      const value = i[key];
      if (JSON.stringify(value) === JSON.stringify(EMPTY[key])) continue;
      out[key] = key === 'target' ? target(value as Target) : key === 'transit' ? station(value as number) : value;
    }
    return out as RecordedInput;
  };
  const observation = (o: Observation): RecordedCommand => {
    switch (o.kind) {
      case 'viewLag': case 'inputLead': return { type: 'observation', kind: o.kind, id: player(o.actor), ticks: o.ticks };
      case 'join': return { type: 'observation', kind: o.kind, id: player(o.actor), ...(o.kit === undefined ? {} : { kit: o.kit }) };
      case 'leave': return { type: 'observation', kind: o.kind, id: player(o.actor) };
      case 'teleport': return { type: 'observation', kind: 'teleport', body: body(o.body), x: o.to[0], y: o.to[1] };
    }
  };
  const carried = (c: Carried): RecordedCommand => {
    switch (c.kind) {
      case 'impulse': return { type: 'carried', kind: 'impulse', body: body(c.body), x: c.impulse[0], y: c.impulse[1] };
      case 'killReward': return { type: 'carried', kind: 'killReward', id: player(c.actor) };
      case 'gateObserved': return { type: 'carried', kind: 'gateObserved', id: player(c.actor), gate: ids.gateIds[c.gate]!, open: c.open, locked: c.locked };
    }
  };
  return inbound.filter(row => row.type !== 'command' || row.command.source !== 'bot').map(row => row.type === 'command'
    ? { type: 'command', id: player(row.command.actor), source: row.command.source, tick: row.command.tick, seq: row.command.seq, input: input(row.command.input) }
    : row.type === 'observation' ? observation(row.observation) : carried(row.carried));
}

/**
 * Recorded `command` and `observation` rows as the inbound rows the core queued, for resimulation (#1284, docs/26
 * "Schema 25"). It inverts `recordedInbound` under the IDs bound when the frame was recorded. `carried` rows are refused:
 * the core regenerates its own carry. A recorded join leaves out the bot label a seat relabel carried, so `labels` gives it
 * back by player ID, computed when the room's join bound the label.
 */
export function inboundOfRecorded(ids: MatchIds, rows: readonly RecordedCommand[], labels: ReadonlyMap<PlayerId, BotLabel> = new Map()): Inbound[] {
  const actor = (id: PlayerId): number => {
    const word = ids.actorOfPlayer.get(id);
    if (word === undefined) throw new RangeError(`tick-record: no actor for player ${id}`);
    return word;
  };
  const number = (text: string, what: string): number => {
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 0 || String(value) !== text) throw new RangeError(`tick-record: invalid ${what} ${text}`);
    return value;
  };
  const body = (label: RecordedBody): BodyRef => {
    const split = label.indexOf(':'), kind = label.slice(0, split), rest = label.slice(split + 1);
    if (kind === 'actor') return { kind, id: actor(rest as PlayerId) };
    if (kind === 'prop') return { kind, id: ids.propNumber.get(rest) ?? number(rest, 'prop') };
    if (kind === 'item' || kind === 'gate' || kind === 'geometry') return { kind, id: number(rest, kind) };
    throw new RangeError(`tick-record: invalid body ${label}`);
  };
  const station = (id: string): number => {
    const index = ids.stations.findIndex(s => s.id === id);
    if (index < 0) throw new RangeError(`tick-record: no station ${id}`);
    return index;
  };
  const target = (t: RecordedTarget): Target => {
    if (!('id' in t) || t.kind === 'item') return t as Target;
    if (t.kind === 'station') return { kind: 'station', id: station(t.id) };
    const gate = ids.gateIndex.get(t.id as GateId);
    if (gate === undefined) throw new RangeError(`tick-record: no gate ${t.id}`);
    return { kind: 'gate', id: gate };
  };
  const input = (recorded: RecordedInput): Input => {
    const { target: t, transit, ...rest } = recorded;
    return { ...emptyInput(), ...structuredClone(rest), ...(t === undefined ? {} : { target: target(t) }),
      ...(transit === undefined ? {} : { transit: station(transit) }) };
  };
  return rows.map((row): Inbound => {
    if (row.type === 'command') {
      return { type: 'command', command: { actor: actor(row.id), source: row.source, tick: row.tick, seq: row.seq, input: input(row.input) } };
    }
    if (row.type !== 'observation') throw new RangeError(`tick-record: ${row.type} rows are regenerated, not replayed`);
    switch (row.kind) {
      case 'viewLag': case 'inputLead': return { type: 'observation', observation: { kind: row.kind, actor: actor(row.id), ticks: row.ticks } };
      case 'join': {
        const label = labels.get(row.id);
        return { type: 'observation', observation: { kind: 'join', actor: actor(row.id),
          ...(row.kit === undefined ? {} : { kit: row.kit }), ...(label === undefined ? {} : { botLabel: label }) } };
      }
      case 'leave': return { type: 'observation', observation: { kind: 'leave', actor: actor(row.id) } };
      case 'teleport': return { type: 'observation', observation: { kind: 'teleport', body: body(row.body), to: [row.x, row.y] } };
    }
  });
}
