import { emptyInput } from './tick-codec.ts';
import type { BodyRef, Carried, Command, Inbound, Input, Observation, Target } from './tick-codec.ts';
import type { MatchIds } from './tick-match.ts';
import type { Kit, PlayerId, Tick } from '../types.ts';

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
