import test from 'node:test';
import assert from 'node:assert/strict';
import { roomHarness } from './helpers/room-harness.js';
import { STATE_SCHEMA, readServerMessage, wireCodec } from '../shared/wire-schema.ts';
import { createDescriptorCodec, FORMAT } from '../shared/wire-codec.ts';
import { WIRE_VERSION } from '../shared/protocol.ts';
import {
  eventFields, ownPlayerFields, physicsBodyFields, physicsHookFlightFields, physicsTetherFields, projectileFields, trapFields,
} from '../shared/simulation/projection-contract.ts';
import { observed } from '../shared/simulation/visibility.ts';
import { waitingView } from '../shared/simulation/waiting.ts';

// The descriptor codec's outbound schema (#1131 stage 1): every live `state` message decodes to exactly what
// JSON.parse gives, constructed records match their builders, and malformed bytes are refused (24.1).

const codec = wireCodec();
const roundTrip = message => codec.decode(codec.encode(message));
const fieldNames = name => STATE_SCHEMA.records[name].fields.map(f => f.name);

// One short room: two players waiting, then a match seen by both, a dev view and a delayed spectator.
let traffic;
async function liveTraffic() {
  if (traffic) return traffic;
  const h = roomHarness({ devTools: 'all', reuseMaps: true }), made = await h.room();
  const owner = h.joined(made, { ownerKey: made.ownerKey }), other = h.joined(made, { role: 'gladiator' });
  try {
    for (let i = 0; i < 3; i++) h.wake(50);
    owner.send({ type: 'start' });
    const dev = h.joined(made, { mode: 'dev' }), spectator = h.joined(made, { mode: 'spectator' });
    for (let i = 0; i < 120; i++) h.wake(50);
    traffic = [owner, other, dev, spectator].flatMap(p => p.rawMessages.filter(m => m.type === 'state'));
    return traffic;
  } finally { await h.service.close(); }
}

test('every live state message of a room decodes to what JSON gives, in a fraction of the bytes', async () => {
  const messages = await liveTraffic();
  const phases = new Set(messages.map(m => m.state.phase));
  assert.ok(phases.has('waiting') && phases.has('live'), `waiting and match frames: ${[...phases]}`);
  assert.ok(messages.some(m => 'all' in (m.state.items ?? {})) && messages.some(m => m.state.items && !('all' in m.state.items) && 'k' in m.state.items),
    'item keyframes and change sets both occur');
  let json = 0, binary = 0;
  for (const message of messages) {
    const bytes = codec.encode(message);
    assert.deepEqual(codec.decode(bytes), message);
    json += JSON.stringify(message).length; binary += bytes.length;
  }
  assert.ok(binary < json / 3, `binary ${binary} B against JSON ${json} B`);
  // The client's reader takes both forms (public/room-connection.js).
  const message = messages.at(-1), bytes = codec.encode(message);
  assert.deepEqual(readServerMessage(bytes), message);
  assert.deepEqual(readServerMessage(bytes.slice().buffer), message);
  assert.deepEqual(readServerMessage(JSON.stringify(message)), message);
});

const shapes = [{ kind: 'circle', radius: 12.25 }, { kind: 'box', hx: 8, hy: 0.1 }, { kind: 'convex', vertices: [{ x: 0, y: 0 }, { x: 4.5, y: -3 }, { x: 0.1, y: 7 }] }];
const owners = [{ kind: 'actor', playerIdx: 2 }, { kind: 'item', itemId: 41 }, { kind: 'prop', propId: 0 }];
const body = (shape, owner, extra = {}) => ({ id: 7, kind: owner.kind === 'actor' ? 'actor' : 'prop', shape, x: 40 * Math.fround(1.3), y: -80, angle: Math.fround(0.5),
  vx: 40 * Math.fround(-2.7), vy: 0, omega: Math.fround(0.25), sleeping: false, generation: 33, owner, ...extra });

test('records the projection constructs have exactly the schema fields', () => {
  const full = physicsBodyFields(body(shapes[0], owners[0], { discontinuity: 'placed' }), true);
  assert.deepEqual(Object.keys(full).sort(), fieldNames('Body').sort());
  const variant = { circle: 'ShapeCircle', box: 'ShapeBox', convex: 'ShapeConvex', actor: 'OwnerActor', item: 'OwnerItem', prop: 'OwnerProp' };
  for (const shape of shapes) assert.deepEqual(Object.keys(physicsBodyFields(body(shape, owners[0])).shape).filter(k => k !== 'kind'), fieldNames(variant[shape.kind]));
  for (const owner of owners) assert.deepEqual(Object.keys(physicsBodyFields(body(shapes[0], owner)).owner).filter(k => k !== 'kind'), fieldNames(variant[owner.kind]));
  assert.deepEqual(Object.keys(physicsBodyFields(body(shapes[2], owners[0])).shape.vertices[0]), fieldNames('Vertex'));
  assert.deepEqual(Object.keys(physicsTetherFields({ id: 1, a: 2, b: 3 })), fieldNames('Tether'));
  assert.deepEqual(Object.keys(physicsHookFlightFields({ id: 1, a: 2, casterIdx: 0, x: 1, y: 2 })), fieldNames('HookFlight'));
  const own = ownPlayerFields({ x: 1, y: 2, hp: 3, inventory: [], reload: { slot: 0, instanceId: 4, until: 9 } }, { discovered: new Set([5]) }, [{ x: 1, y: 2, tick: 3, until: 4 }], 0);
  assert.deepEqual(Object.keys(own.heard[0]), fieldNames('Heard'));
  assert.deepEqual(Object.keys(own.reload), fieldNames('Reload'));
  for (const key of ['playerIdx', 'heard', 'discovered']) assert.ok(fieldNames('Own').includes(key), `own ${key}`);
  const seen = observed({ heading: 0, status: 'active', hp: 1, maxHp: 1, shield: 0, weapon: 0, cloak: 0, revealed: 0, x: 0, y: 0 }, 1);
  assert.deepEqual(Object.keys(seen).sort(), fieldNames('Observed').sort());
  const participant = eventFields({ id: 1, tick: 2, kind: 'eliminated', target: { playerIdx: 0, name: 'A', extra: 1 } }).target;
  assert.deepEqual(Object.keys(participant), fieldNames('Participant'));
  // `phase` is the state union's discriminant, carried as its tag rather than a field.
  assert.deepEqual(Object.keys(waitingView({ players: [], tick: 0, discontinuities: new Map() }, 'nobody')).filter(k => k !== 'phase').sort(),
    fieldNames('WaitingState').filter(f => !['tethers', 'hookFlights', 'predictionMotor', 'self'].includes(f)).sort());
});

test('families a short bot match never sends round-trip exactly', async () => {
  const base = structuredClone((await liveTraffic()).find(m => m.state.phase === 'live' && m.state.self));
  const state = base.state;
  state.bodies = { k: 9, all: [...shapes.flatMap(shape => owners.map(owner => physicsBodyFields(body(shape, owner), owner.kind !== 'actor')))],
    set: [physicsBodyFields(body(shapes[1], owners[1], { discontinuity: 'placed' }))], drop: [3, 1048575] };
  delete state.bodies.set[0].shape; // a change set omits a shape its keyframe holds (24.4)
  state.tethers = [physicsTetherFields({ id: 5, a: 7, b: 8 })];
  state.hookFlights = [physicsHookFlightFields({ id: 5, a: 7, casterIdx: 2, x: 10.123456789, y: -4 })];
  state.predictionTethered = true; state.hookActive = true;
  state.traps = [trapFields({ id: 'trap-1', kind: 'turret', x: 3, y: 4.5, homeX: 3, homeY: 4, heading: Math.PI / 3, offset: 2, cooldown: 7.5, spent: false, aiming: true, firing: false, warning: true, targetId: 'c0' })];
  state.projectiles = [projectileFields({ id: 3, owner: 'trap-1', trap: true, x: 1 / 3, y: 2, dx: Math.cos(1) * 35, dy: Math.sin(1) * 35, life: 4, damage: 10.8 })];
  state.events = [
    { kind: 'pod_powered', actor: { playerIdx: 0, name: 'Mica' }, slotsRemaining: 2 }, { kind: 'cell_charged', actor: { playerIdx: 1, name: 'Ω' } },
    { kind: 'eliminated', target: { playerIdx: 1, name: 'Rook' }, source: { playerIdx: 0, name: 'Mica' } }, { kind: 'eliminated', target: { playerIdx: 3, name: 'x' } },
    { kind: 'respawned', actor: { playerIdx: 1, name: 'Rook' } }, { kind: 'match_finished' },
  ].map((e, i) => eventFields({ id: i + 1, tick: 100 + i, ...e }));
  state.effects = [{ id: 9, x: 41.62, y: 3134, kind: 'slash', radius: 30, life: 12 }];
  state.self = { ...state.self, hp: 87.04, shield: 12.5, heading: -2.5, lastSeq: -1, inputMargin: -3, inputStalled: 2,
    inventory: [null, { id: 4, kind: 'weapon', weaponType: 'rifle', ammo: 30, quality: 2 }, null], selectedSlot: 1,
    reserves: { pistol: 12, shell: 0 }, reload: { slot: 1, instanceId: 4, until: 1234.5 }, charging: 'station-3', respawnAt: null,
    cell: { id: 6, kind: 'cell', charge: 40 }, nodeId: 'cell@1,2', heard: [{ x: 120, y: 360, tick: 50, until: 70 }] };
  const message = { type: 'state', state };
  assert.deepEqual(roundTrip(message), message);
  state.self = { ...state.self, charging: null, respawnAt: 900, reload: null };
  assert.deepEqual(roundTrip(message), message);
});

test('numbers, strings and absence keep their exact JSON meaning', async () => {
  const base = (await liveTraffic()).find(m => m.state.phase === 'live' && m.state.self);
  const withSelf = self => ({ type: 'state', state: { ...base.state, self: { ...base.state.self, ...self } } });
  for (const hp of [0, -0, 1, 2 ** 50, -(2 ** 50), 2 ** 50 + 2, 0.1, Math.fround(0.1), 40 * Math.fround(0.1), Number.MIN_VALUE, -Number.MAX_VALUE, 1e300]) {
    const decoded = roundTrip(withSelf({ hp })).state.self.hp;
    assert.ok(Object.is(decoded, JSON.parse(JSON.stringify(hp))), `hp ${hp} decoded as ${decoded}`);
  }
  // Lone surrogates survive in their own form; well-formed text of any script travels as UTF-8.
  for (const name of ['', 'Rook', 'Ωmega 漢字 🙂', '\uD800', 'a\uDC00b', 'x'.repeat(200)]) {
    const message = withSelf({ charging: name });
    assert.equal(roundTrip(message).state.self.charging, name);
  }
  // Absent and null are different, and neither is invented.
  const absent = structuredClone(base); delete absent.state.self.reload;
  assert.equal('reload' in roundTrip(absent).state.self, false);
  assert.equal(roundTrip(withSelf({ reload: null })).state.self.reload, null);
});

test('values outside the schema are refused on encode', async () => {
  const base = (await liveTraffic()).find(m => m.state.phase === 'live' && m.state.self);
  const variant = change => { const message = structuredClone(base); change(message.state); return () => codec.encode(message); };
  for (const [why, change] of [
    ['an undeclared field', s => { s.secret = 1; }],
    ['an undeclared own field', s => { s.self.inventoryTotal = 3; }],
    ['a missing required field', s => { delete s.tick; }],
    ['a value outside its enum', s => { s.self.status = 'ghost'; }],
    ['a non-finite number', s => { s.self.hp = NaN; }],
    ['a fractional counter', s => { s.tick = 1.5; }],
    ['a negative counter', s => { s.contestantsActive = -1; }],
    ['an unknown phase', s => { s.phase = 'paused'; }],
    ['a body pose that is not float32 metres', s => { s.bodies = [physicsBodyFields(body(shapes[0], owners[0], { x: 0.1 }))]; }],
    ['an unknown layer key', s => { s.items = { k: 1, extra: [] }; }],
    ['null where none is declared', s => { s.self.hp = null; }],
  ]) assert.throws(variant(change), TypeError, why);
  assert.throws(() => codec.encode({ type: 'welcome' }), TypeError);
});

test('malformed bytes are refused, never read as another message', async () => {
  const messages = await liveTraffic(), step = Math.floor(messages.length / 6);
  const samples = messages.filter((_, i) => i % step === 0).map(m => codec.encode(m));
  for (const bytes of samples) {
    for (let cut = 0; cut < bytes.length; cut++) assert.throws(() => codec.decode(bytes.subarray(0, cut)), RangeError, `cut at ${cut}`);
    const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes);
    assert.throws(() => codec.decode(trailing), /trailing bytes/);
  }
  const header = [FORMAT, WIRE_VERSION, 1];
  const refuse = (bytes, why) => assert.throws(() => codec.decode(Uint8Array.from(bytes)), why);
  refuse([0x7b, WIRE_VERSION, 1], /unknown format/); // '{', a JSON message
  refuse([FORMAT, WIRE_VERSION + 1, 1], /unsupported schema version/);
  refuse([FORMAT, WIRE_VERSION, 99], /unknown message type/);
  refuse([...header, 7], /bad union tag/);
  refuse([FORMAT, 0x80 | WIRE_VERSION, 0x00, 1], /non-canonical varint/);
  // A list claiming 2^31 entries in a few bytes is refused before anything is allocated.
  const first = samples[0];
  refuse([...header, 2, 0x80, 0x80, 0x80, 0x80, 0x08], RangeError);
  const tight = createDescriptorCodec(STATE_SCHEMA, { maxBytes: 64 });
  assert.throws(() => tight.decode(first), /message too large/);
  // Seeded corruption past the header: whatever it decodes to is a valid message of the schema, or a refusal.
  let seed = 1131; const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < 400; i++) {
    const bytes = samples[i % samples.length].slice(), at = 3 + Math.floor(random() * (bytes.length - 3));
    bytes[at] ^= 1 + Math.floor(random() * 255);
    try { const message = codec.decode(bytes); assert.deepEqual(roundTrip(message), message); }
    catch (error) { assert.ok(error instanceof RangeError, `${error}`); }
  }
});

test('the schema refuses recursion, duplicate fields and unknown types when built', () => {
  const build = records => () => createDescriptorCodec({ version: 1, messages: { m: { id: 1, record: 'A' } }, records });
  assert.throws(build({ A: { fields: [{ name: 'b', type: 'B' }] }, B: { fields: [{ name: 'a', type: 'A' }] } }), /recursive/);
  assert.throws(build({ A: { fields: [{ name: 'x', type: 'uint' }, { name: 'x', type: 'str' }] } }), /duplicate field/);
  assert.throws(build({ A: { fields: [{ name: 'x', type: 'Nope' }] } }), /unknown record/);
});
