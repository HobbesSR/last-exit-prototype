// The typed schema of the outbound `state` message for the descriptor codec (#1131, 24.1, 24.3, 42.54).
// Field names come from the projection owners (projection-contract.ts), not a second list: each record below
// is checked against its owner's declaration when this module loads, and refuses an untyped field or a type
// for a field the owner does not declare. Records the projection constructs rather than declares (bodies,
// owners, shapes, tethers, hook flights, heard cues, the prediction motor and the waiting frame) are checked
// against their builders by tests/wire-codec.test.js. Disclosure stays with the projection: this is not a
// privacy list, only the types of what the projection already sends.
//
// Types follow 24.3's inventory and its no-behaviour-change proposals 1 and 2, as measured exact in 42.54:
// body poses are float32 metres, counters, ticks and keyed IDs (#1164) unsigned integers, content-derived
// quantities (hit points, shields, cooldowns, radii, damage) exact numbers, closed unions enum tables.
import { WIRE_VERSION } from './protocol.ts';
import { UNITS_PER_METRE } from './physics/units.ts';
import { FAST_QUANTA, SLOW_FIELDS } from './fast-state.ts';
import { createDescriptorCodec, type DecodeOptions, type DescriptorCodec, type FieldDef, type FieldType, type RecordDef, type Schema } from './wire-codec.ts';
import { AMMO_FAMILIES, BODY_KINDS, EFFECT_KINDS, EVENT_KINDS, ITEM_KINDS, PHASES, PLAYER_STATUSES, TRAP_KINDS, WEAPONS } from './enum-tables.ts';
import {
  EFFECT_FIELDS, EVENT_FIELDS, FRAME_FIELDS, GATE_FIELDS, ITEM_FIELDS, OBSERVED, OWN_FIELDS, PROJECTILE_FIELDS, TRAP_FIELDS,
} from './simulation/projection-contract.ts';

const list = (type: FieldType): FieldType => ({ list: type });
const nullable = (type: FieldType): FieldType => ({ nullable: type });
const layer = (type: FieldType): FieldType => ({ layer: type });
const oneOf = (values: readonly string[]): FieldType => ({ enum: values });

/**
 * A record whose fields are exactly `fields` (an owner's declaration), typed by `types`. `optional` names the
 * fields a projection may leave out; `all` makes every field optional, as copied-when-present records are.
 */
function typed(name: string, fields: readonly string[], types: Readonly<Record<string, FieldType>>, optional: readonly string[] | 'all' = []): RecordDef {
  const missing = fields.filter(f => !(f in types)), extra = Object.keys(types).filter(t => !fields.includes(t));
  if (missing.length || extra.length) throw new Error(`wire schema ${name}: untyped fields [${missing}] or undeclared types [${extra}]`);
  if (optional !== 'all') for (const f of optional) if (!fields.includes(f)) throw new Error(`wire schema ${name}: optional ${f} is not a field`);
  return { fields: fields.map((f): FieldDef => ({ name: f, type: types[f]!, ...(optional === 'all' || optional.includes(f) ? { optional: true } : {}) })) };
}
const words = (declared: string) => declared.split(' ');

// ---- Records the projection declares by field list -----------------------------------------------------------

const ITEM = typed('Item', words(ITEM_FIELDS), {
  id: 'uint', x: 'exact', y: 'exact', kind: oneOf(ITEM_KINDS), weaponType: oneOf(WEAPONS), ammo: 'uint', charge: 'uint', count: 'uint',
  buildingId: 'str', tier: 'uint', quality: 'exact', family: oneOf(AMMO_FAMILIES),
}, 'all'); // copied when present; a physical item's pose is its body's (24.4)

const OWN_DECLARED = words(OWN_FIELDS);
// The viewer's own record: the declared fields, copied when present, and those ownPlayerFields constructs.
const OWN = typed('Own', [...OWN_DECLARED, 'playerIdx', 'heard'], {
  x: 'exact', y: 'exact', hp: 'exact', maxHp: 'exact', shield: 'exact', keys: 'uint', weapon: 'uint', kills: 'uint', level: 'uint',
  status: oneOf(PLAYER_STATUSES), cooldown: 'exact', railCd: 'uint', cloak: 'uint', revealed: 'uint', boost: 'uint',
  stun: 'uint', heading: 'f64', lastSeq: 'sint', inputStalled: 'uint', inputMargin: 'sint', inventory: list(nullable('Item')),
  // `reload`, `charging` and `respawnAt` are absent for none, never null (24.3 proposal 6).
  selectedSlot: 'uint', reserves: { enumMap: [AMMO_FAMILIES, 'uint'] }, reload: 'Reload', charging: 'str',
  respawnAt: 'uint', discovered: layer('uint'), playerIdx: 'uint', heard: list('Heard'),
}, 'all');

const OBSERVED_RECORD = typed('Observed', ['playerIdx', ...OBSERVED, 'x', 'y'], {
  playerIdx: 'uint', heading: 'f64', status: oneOf(PLAYER_STATUSES), hp: 'exact', maxHp: 'exact', shield: 'exact', weapon: 'uint',
  cloak: 'uint', revealed: 'uint', x: 'exact', y: 'exact',
}, ['x', 'y']); // a player with a body carries its pose there only (24.4)

const GATE = typed('Gate', words(GATE_FIELDS), { gateIdx: 'uint', open: 'bool', locked: 'bool' });
// Copied when present: authored traps carry only the fields their kind uses, and `spent` is set only once a
// mine fires (rust/core/src/hazards.rs). No production map places traps yet (24.3).
const TRAP = typed('Trap', words(TRAP_FIELDS), {
  id: 'str', kind: oneOf(TRAP_KINDS), x: 'exact', y: 'exact', homeX: 'exact', homeY: 'exact', heading: 'f64', offset: 'exact',
  cooldown: 'exact', spent: 'bool', aiming: 'bool', firing: 'bool', warning: 'bool',
}, ['homeX', 'homeY', 'heading', 'offset', 'cooldown', 'spent', 'aiming', 'firing', 'warning']);
const PROJECTILE = typed('Projectile', words(PROJECTILE_FIELDS), {
  id: 'uint', owner: 'str', trap: 'bool', x: 'f64', y: 'f64', dx: 'f64', dy: 'f64', life: 'uint', damage: 'exact',
}, ['trap']);
const EFFECT = typed('Effect', words(EFFECT_FIELDS), { id: 'uint', x: 'exact', y: 'exact', kind: oneOf(EFFECT_KINDS), radius: 'exact', life: 'uint' });
const EVENT = typed('Event', words(EVENT_FIELDS), {
  id: 'uint', tick: 'uint', kind: oneOf(EVENT_KINDS), actor: 'Participant', target: 'Participant', source: 'Participant',
  slotsRemaining: 'uint', text: 'str',
}, ['actor', 'target', 'source', 'slotsRemaining', 'text']);

// ---- Records the projection constructs ------------------------------------------------------------------------

const HOOK_FLIGHT: RecordDef = { fields: [
  { name: 'id', type: 'uint' }, { name: 'a', type: 'uint' }, { name: 'casterIdx', type: 'uint' }, { name: 'x', type: 'exact' }, { name: 'y', type: 'exact' },
] };

const BODY: RecordDef = { fields: [
  { name: 'id', type: 'uint' }, { name: 'kind', type: oneOf(BODY_KINDS) },
  // Omitted when the receiving keyframe already holds it (24.4 baseline shape compression).
  { name: 'shape', type: { union: 'kind', variants: { circle: 'ShapeCircle', box: 'ShapeBox', convex: 'ShapeConvex' } }, optional: true },
  { name: 'x', type: 'f32m' }, { name: 'y', type: 'f32m' }, { name: 'angle', type: 'f32' },
  // Only for bodies the viewer predicts: its own actor and every non-actor (physicsBodyFields `full`).
  { name: 'vx', type: 'f32m', optional: true }, { name: 'vy', type: 'f32m', optional: true },
  { name: 'generation', type: 'uint' },
  { name: 'owner', type: { union: 'kind', variants: { actor: 'OwnerActor', item: 'OwnerItem', prop: 'OwnerProp' } } },
  { name: 'discontinuity', type: oneOf(['placed']), optional: true },
] };

// The roster revision the frame was projected against (#1131): added by the transport, not the projection.
const ROSTER_REVISION: FieldDef = { name: 'rosterRevision', type: 'uint' };
// The version of a view's slow layers (24.5 stage 3): a `slow` message carries it, and each `fast` names the one
// its frame was projected with, so a reader can tell when it reads across the two.
const SLOW_VERSION: FieldDef = { name: 'slowVersion', type: 'uint' };
const STATE_TAIL: FieldDef[] = [
  { name: 'players', type: list('Observed') }, { name: 'items', type: layer('Item') }, { name: 'gates', type: layer('Gate') },
  { name: 'traps', type: list('Trap') }, { name: 'projectiles', type: list('Projectile') }, { name: 'effects', type: list('Effect') },
];
// The physics profile and prediction motor are match constants, sent with the map (24.3 proposal 3).
const PHYSICS: FieldDef[] = [
  { name: 'bodies', type: layer('Body'), optional: true },
  { name: 'tethers', type: layer('Tether'), optional: true }, { name: 'hookFlights', type: list('HookFlight'), optional: true },
];
const FRAME_TYPES: Readonly<Record<string, FieldType>> = { tick: 'uint', phase: oneOf(PHASES), hazardX: 'exact', slots: 'uint' };
// The match frame: the declared frame fields, then playerView's (shared/simulation/visibility.ts).
const frame = typed('Frame', words(FRAME_FIELDS), FRAME_TYPES).fields.filter(f => f.name !== 'phase');
const MATCH_STATE: RecordDef = { fields: [
  ...frame, { name: 'contestantsActive', type: 'uint' }, ...PHYSICS,
  { name: 'predictionTethered', type: 'bool', optional: true }, { name: 'hookActive', type: 'bool', optional: true },
  { name: 'self', type: 'Own', optional: true }, ...STATE_TAIL, { name: 'events', type: list('Event'), optional: true }, ROSTER_REVISION,
] };
// The waiting yard's frame (shared/simulation/waiting.ts waitingView), in the match frame's shape.
const WAITING_STATE: RecordDef = { fields: [
  { name: 'tick', type: 'uint' }, ...PHYSICS, { name: 'self', type: 'Own', optional: true },
  ...STATE_TAIL, { name: 'events', type: list('Event') }, ROSTER_REVISION,
] };

// The fast part of a match frame (fast-state.ts), for datagrams (24.5 stage 3): the match frame without its slow
// layers and the transport's roster revision, which the message carries beside it. Its keyed lists name their
// key, so a delta carries a list's changed entries rather than the list (wire-codec.ts "Deltas").
const FAST_KEYS: Readonly<Record<string, readonly [string, string]>> = {
  bodies: ['Body', 'id'], tethers: ['Tether', 'id'], hookFlights: ['HookFlight', 'id'], players: ['Observed', 'playerIdx'],
  traps: ['Trap', 'id'], projectiles: ['Projectile', 'id'], effects: ['Effect', 'id'], events: ['Event', 'id'],
};
const FAST_LEFT_OUT = new Set<string>([...SLOW_FIELDS, ROSTER_REVISION.name]);
// The fast part rounds FAST_QUANTA's fields (fast-state.ts, 24.2 decision 3): its records for those lists are
// their state records with each rounded field typed as its grid. `state` keeps the exact records.
const ROUNDED_SOURCES: Readonly<Record<string, RecordDef>> = { Observed: OBSERVED_RECORD, Trap: TRAP, Projectile: PROJECTILE, Effect: EFFECT, HookFlight: HOOK_FLIGHT };
const FAST_RECORDS: Record<string, RecordDef> = {};
for (const [list, quanta] of Object.entries(FAST_QUANTA)) {
  const name = FAST_KEYS[list]?.[0], fields = name ? ROUNDED_SOURCES[name]?.fields : undefined;
  if (!name || !fields) throw new Error(`wire schema: rounded list ${list} is not a keyed list of a known record`);
  for (const field of Object.keys(quanta)) if (!fields.some(f => f.name === field)) throw new Error(`wire schema ${name}: no field ${field} to round`);
  FAST_RECORDS[`Fast${name}`] = { fields: fields.map(f => (f.name in quanta ? { ...f, type: { grid: quanta[f.name]! } } : f)) };
}
const FAST_MATCH: RecordDef = { fields: MATCH_STATE.fields.filter(f => !FAST_LEFT_OUT.has(f.name)).map((f): FieldDef => {
  const keyed = FAST_KEYS[f.name];
  return keyed ? { ...f, type: { list: f.name in FAST_QUANTA ? `Fast${keyed[0]}` : keyed[0], key: keyed[1] } } : f;
}) };
for (const name of Object.keys(FAST_KEYS)) if (!FAST_MATCH.fields.some(f => f.name === name)) throw new Error(`wire schema FastMatch: no field ${name} to key`);

/** The schema; its version is the wire version, so any contract bump refuses the other side's bytes. */
export const STATE_SCHEMA: Schema = Object.freeze({
  version: WIRE_VERSION,
  unitsPerMetre: UNITS_PER_METRE,
  // A player session with datagrams is sent `fast` on datagrams and `slow` on its stream (24.5 stage 3).
  messages: { state: { id: 1, record: 'StateMessage' }, fast: { id: 2, record: 'FastMessage' }, slow: { id: 3, record: 'SlowMessage' } },
  records: {
    StateMessage: { fields: [{ name: 'state', type: { union: 'phase', variants: { live: 'MatchState', finished: 'MatchState', waiting: 'WaitingState' } } }] },
    FastMessage: { fields: [ROSTER_REVISION, SLOW_VERSION, { name: 'state', type: { delta: { union: 'phase', variants: { live: 'FastMatch', finished: 'FastMatch' } } } }] },
    SlowMessage: { fields: [SLOW_VERSION, { name: 'items', type: layer('Item') }, { name: 'gates', type: layer('Gate') }, { name: 'discovered', type: layer('uint'), optional: true }] },
    MatchState: MATCH_STATE, WaitingState: WAITING_STATE, FastMatch: FAST_MATCH,
    Own: OWN, Observed: OBSERVED_RECORD, Item: ITEM,
    Reload: { fields: [{ name: 'slot', type: 'uint' }, { name: 'until', type: 'exact' }] },
    Heard: { fields: [{ name: 'x', type: 'exact' }, { name: 'y', type: 'exact' }, { name: 'tick', type: 'uint' }, { name: 'until', type: 'uint' }] },
    Gate: GATE, Trap: TRAP, Projectile: PROJECTILE, Effect: EFFECT, Event: EVENT,
    Participant: { fields: [{ name: 'playerIdx', type: 'uint' }, { name: 'name', type: 'str' }] },
    Body: BODY,
    ShapeCircle: { fields: [{ name: 'radius', type: 'exact' }] },
    ShapeBox: { fields: [{ name: 'hx', type: 'exact' }, { name: 'hy', type: 'exact' }] },
    ShapeConvex: { fields: [{ name: 'vertices', type: list('Vertex') }] },
    Vertex: { fields: [{ name: 'x', type: 'exact' }, { name: 'y', type: 'exact' }] },
    OwnerActor: { fields: [{ name: 'playerIdx', type: 'uint' }] },
    OwnerItem: { fields: [{ name: 'itemId', type: 'uint' }] },
    OwnerProp: { fields: [{ name: 'propId', type: 'uint' }] },
    Tether: { fields: [{ name: 'id', type: 'uint' }, { name: 'a', type: 'uint' }, { name: 'b', type: 'uint' }] },
    HookFlight: HOOK_FLIGHT, ...FAST_RECORDS,
  },
});

let codec: DescriptorCodec | undefined;
/** The compiled codec for outbound live messages, built once on first use. */
export function wireCodec(): DescriptorCodec {
  return codec ??= createDescriptorCodec(STATE_SCHEMA);
}

/**
 * A server message as a socket delivers it: JSON text, or the descriptor codec's bytes. Throws for anything
 * that is neither, so a reader never guesses at a message it cannot read (24.1 rollout). `options.baseline`
 * supplies the baselines a `fast` delta names; one it lacks throws `MissingBaseline` (wire-codec.ts).
 */
export function readServerMessage(data: string | ArrayBuffer | Uint8Array, options?: DecodeOptions): Record<string, unknown> {
  if (typeof data === 'string') {
    const message: unknown = JSON.parse(data);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('a server message is an object');
    return message as Record<string, unknown>;
  }
  return wireCodec().decode(data instanceof Uint8Array ? data : new Uint8Array(data), options);
}
