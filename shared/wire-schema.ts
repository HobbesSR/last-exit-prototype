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
import { createDescriptorCodec, type DescriptorCodec, type FieldDef, type FieldType, type RecordDef, type Schema } from './wire-codec.ts';
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
  buildingId: 'str', droppedBy: 'str', pickupAfter: 'uint', nodeId: 'str', tier: 'uint', instanceId: 'uint', lineageId: 'uint',
  quality: 'exact', family: oneOf(AMMO_FAMILIES),
}, 'all'); // copied when present; a physical item's pose is its body's (24.4)

const OWN_DECLARED = words(OWN_FIELDS);
// The viewer's own record: the declared fields, copied when present, and those ownPlayerFields constructs.
const OWN = typed('Own', [...OWN_DECLARED, 'playerIdx', 'heard'], {
  x: 'exact', y: 'exact', hp: 'exact', maxHp: 'exact', shield: 'exact', keys: 'uint', weapon: 'uint', kills: 'uint', level: 'uint',
  status: oneOf(PLAYER_STATUSES), cooldown: 'exact', attackCd: 'exact', railCd: 'uint', cloak: 'uint', revealed: 'uint', boost: 'uint',
  stun: 'uint', heading: 'f64', lastSeq: 'sint', inputStalled: 'uint', inputMargin: 'sint', inventory: list(nullable('Item')),
  selectedSlot: 'uint', reserves: { enumMap: [AMMO_FAMILIES, 'uint'] }, reload: nullable('Reload'), charging: nullable('str'),
  respawnAt: nullable('uint'), cell: 'Item', nodeId: 'str', discovered: layer('uint'), playerIdx: 'uint', heard: list('Heard'),
}, 'all');

const OBSERVED_RECORD = typed('Observed', ['playerIdx', ...OBSERVED, 'x', 'y'], {
  playerIdx: 'uint', heading: 'f64', status: oneOf(PLAYER_STATUSES), hp: 'exact', maxHp: 'exact', shield: 'exact', weapon: 'uint',
  cloak: 'uint', revealed: 'uint', x: 'exact', y: 'exact',
}, ['x', 'y']); // a player with a body carries its pose there only (24.4)

const GATE = typed('Gate', words(GATE_FIELDS), { gateIdx: 'uint', open: 'bool', locked: 'bool' });
// Copied when present: authored traps carry only the fields their kind uses, and `spent` is set only once a
// mine fires (shared/traps.ts). No production map places traps yet (24.3).
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

const BODY: RecordDef = { fields: [
  { name: 'id', type: 'uint' }, { name: 'kind', type: oneOf(BODY_KINDS) },
  // Omitted when the receiving keyframe already holds it (24.4 baseline shape compression).
  { name: 'shape', type: { union: 'kind', variants: { circle: 'ShapeCircle', box: 'ShapeBox', convex: 'ShapeConvex' } }, optional: true },
  { name: 'x', type: 'f32m' }, { name: 'y', type: 'f32m' }, { name: 'angle', type: 'f32' },
  // Only for bodies the viewer predicts: its own actor and every non-actor (physicsBodyFields `full`).
  { name: 'vx', type: 'f32m', optional: true }, { name: 'vy', type: 'f32m', optional: true },
  { name: 'omega', type: 'f32', optional: true }, { name: 'sleeping', type: 'bool', optional: true },
  { name: 'generation', type: 'uint' },
  { name: 'owner', type: { union: 'kind', variants: { actor: 'OwnerActor', item: 'OwnerItem', prop: 'OwnerProp' } } },
  { name: 'discontinuity', type: oneOf(['placed']), optional: true },
] };

const STATE_TAIL: FieldDef[] = [
  { name: 'players', type: list('Observed') }, { name: 'items', type: layer('Item') }, { name: 'gates', type: layer('Gate') },
  { name: 'traps', type: list('Trap') }, { name: 'projectiles', type: list('Projectile') }, { name: 'effects', type: list('Effect') },
];
const PHYSICS: FieldDef[] = [
  { name: 'physicsProfile', type: 'str', optional: true }, { name: 'bodies', type: layer('Body'), optional: true },
  { name: 'tethers', type: layer('Tether'), optional: true }, { name: 'hookFlights', type: list('HookFlight'), optional: true },
  { name: 'predictionMotor', type: 'Motor', optional: true },
];
const FRAME_TYPES: Readonly<Record<string, FieldType>> = {
  version: 'str', duration: 'uint', cellChargeTicks: 'uint', tick: 'uint', phase: oneOf(PHASES), hazardX: 'exact', slots: 'uint',
};
// The match frame: the declared frame fields, then playerView's (shared/simulation/visibility.ts).
const frame = typed('Frame', words(FRAME_FIELDS), FRAME_TYPES).fields.filter(f => f.name !== 'phase');
const MATCH_STATE: RecordDef = { fields: [
  ...frame, { name: 'directed', type: 'bool' }, { name: 'contestantsActive', type: 'uint' }, ...PHYSICS,
  { name: 'predictionTethered', type: 'bool', optional: true }, { name: 'hookActive', type: 'bool', optional: true },
  { name: 'self', type: 'Own', optional: true }, ...STATE_TAIL, { name: 'events', type: list('Event'), optional: true },
] };
// The waiting yard's frame (shared/simulation/waiting.ts waitingView), in the match frame's shape.
const WAITING_STATE: RecordDef = { fields: [
  { name: 'tick', type: 'uint' }, { name: 'directed', type: 'bool' }, ...PHYSICS, { name: 'self', type: 'Own', optional: true },
  ...STATE_TAIL, { name: 'events', type: list('Event') },
] };

/** The schema; its version is the wire version, so any contract bump refuses the other side's bytes. */
export const STATE_SCHEMA: Schema = Object.freeze({
  version: WIRE_VERSION,
  messages: { state: { id: 1, record: 'StateMessage' } },
  records: {
    StateMessage: { fields: [{ name: 'state', type: { union: 'phase', variants: { live: 'MatchState', finished: 'MatchState', waiting: 'WaitingState' } } }] },
    MatchState: MATCH_STATE, WaitingState: WAITING_STATE,
    Motor: { fields: [{ name: 'acceleration', type: 'exact' }, { name: 'braking', type: 'exact' }, { name: 'maxSpeed', type: 'exact' }, { name: 'surfaces', type: 'bool' }] },
    Own: OWN, Observed: OBSERVED_RECORD, Item: ITEM,
    Reload: { fields: [{ name: 'slot', type: 'uint' }, { name: 'instanceId', type: 'uint' }, { name: 'until', type: 'exact' }] },
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
    HookFlight: { fields: [{ name: 'id', type: 'uint' }, { name: 'a', type: 'uint' }, { name: 'casterIdx', type: 'uint' }, { name: 'x', type: 'exact' }, { name: 'y', type: 'exact' }] },
  },
});

let codec: DescriptorCodec | undefined;
/** The compiled codec for outbound live messages, built once on first use. */
export function wireCodec(): DescriptorCodec {
  return codec ??= createDescriptorCodec(STATE_SCHEMA);
}

/**
 * A server message as a socket delivers it: JSON text, or the descriptor codec's bytes. Throws for anything
 * that is neither, so a reader never guesses at a message it cannot read (24.1 rollout).
 */
export function readServerMessage(data: string | ArrayBuffer | Uint8Array): Record<string, unknown> {
  if (typeof data === 'string') {
    const message: unknown = JSON.parse(data);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new TypeError('a server message is an object');
    return message as Record<string, unknown>;
  }
  return wireCodec().decode(data instanceof Uint8Array ? data : new Uint8Array(data));
}
