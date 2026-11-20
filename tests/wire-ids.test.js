import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deserialize } from 'node:v8';
import { gunzipSync } from 'node:zlib';
import { scriptedTrace } from './characterization-physics-scenarios.js';
import { assertWireDomain, wireIds, WIRE_ID_BITS, WIRE_ID_DOMAINS, WIRE_ID_LIMIT } from '../shared/simulation/wire-ids.ts';
import { WIRE_ID_FIELDS } from '../shared/simulation/projection-contract.ts';
import { createGame, disposePhysics, playerView, setInput, snapshot, step, synchronizePhysics } from '../shared/simulation.ts';
import { teleport } from '../shared/simulation/dev.ts';
import { atan2 } from '../shared/math.ts';
import { openArea } from './helpers/arena.js';
import { identifyItems } from './helpers/item-identity.js';
import { createWaiting, enterWaiting, leaveWaiting, waitingView } from '../shared/simulation/waiting.ts';
import { waitingYard } from '../shared/waiting-yard.ts';
import { createMatch } from '../server/match.js';
import { contentById } from '../shared/simulation/content.ts';
import { attachPortalGraph } from '../shared/navigation/portal-graph.ts';

// Keyed outward IDs (#1164, 24.4). One literal key, passed in: never a mocked random source.
const KEY = [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344];
const wire = wireIds(KEY);
const fixture = deserialize(gunzipSync(readFileSync(new URL('./fixtures/behavior-physics-1.v8.gz', import.meta.url))));

test('the keyed mapping takes [0, 2^20 - 1) one-to-one onto [1, 2^20), inverts exactly and refuses what is outside', () => {
  const seen = new Uint8Array(2 ** WIRE_ID_BITS);
  let fixed = 0, bad = 0;
  for (let id = 0; id < WIRE_ID_LIMIT; id++) {
    const out = wire.id(id, 'item');
    if (out < 1 || out >= 2 ** WIRE_ID_BITS || seen[out] || wire.internal(out, 'item') !== id) bad++;
    seen[out] = 1;
    if (out === id) fixed++;
  }
  assert.equal(bad, 0, 'every ID maps to a distinct non-zero ID in the domain and back');
  assert.ok(fixed < 16, `a keyed mapping is not the identity (${fixed} fixed points)`);
  assert.equal(WIRE_ID_LIMIT, 2 ** WIRE_ID_BITS - 1);
  for (const value of [-1, 1.5, WIRE_ID_LIMIT, NaN]) assert.throws(() => wire.id(value, 'item'), RangeError, `${value} is refused, never wrapped`);
  for (const value of [0, 1.5, 2 ** WIRE_ID_BITS, NaN]) assert.throws(() => wire.internal(value, 'item'), RangeError);
  assert.throws(() => wire.id(1, 'player'), TypeError, 'an undeclared domain is refused');
  const other = wireIds([1, 2, 3, 4]);
  assert.notDeepEqual([1, 2, 3].map(id => other.id(id, 'item')), [1, 2, 3].map(id => wire.id(id, 'item')), 'the key decides the mapping');
  // Each domain has its own permutation (one-to-one by the same construction): equal internal values in two
  // counters do not show as equal outward IDs, and each inverts within its own domain.
  for (let id = 0; id < 4096; id++) {
    const outs = WIRE_ID_DOMAINS.map(domain => wire.id(id, domain));
    if (new Set(outs).size !== outs.length || WIRE_ID_DOMAINS.some((domain, i) => wire.internal(outs[i], domain) !== id)) bad++;
  }
  assert.equal(bad, 0, 'domains are separate permutations');
  assert.throws(() => wireIds([1, 2, 3]), TypeError);
  assert.throws(() => wireIds([1, 2, 3, 2 ** 32]), TypeError);
  const identity = wireIds();
  assert.equal(identity.identity, true);
  assert.equal(identity.id(WIRE_ID_LIMIT + 5), WIRE_ID_LIMIT + 5, 'the identity maps nothing');
});

test('a counter outgrowing the outward domain fails loudly, keyed or not', () => {
  assert.throws(() => assertWireDomain({ serial: WIRE_ID_LIMIT, bodies: [] }), RangeError);
  assert.throws(() => assertWireDomain({ serial: 3, itemSerial: WIRE_ID_LIMIT }), RangeError);
  assert.throws(() => assertWireDomain({ serial: 3, bodies: [{ id: WIRE_ID_LIMIT }] }), RangeError);
  assert.throws(() => assertWireDomain({ serial: 3, hookFlights: [{ id: WIRE_ID_LIMIT }] }), RangeError);
  assert.doesNotThrow(() => assertWireDomain({ serial: WIRE_ID_LIMIT - 1, itemSerial: 4, bodies: [{ id: 9 }], tethers: [{ id: 2 }] }));
});

// Where each declared record kind sits in a view. The fields themselves come from WIRE_ID_FIELDS, so a
// field declared there is mapped and checked here, and an undeclared ID-like field fails the walk below.
const LOCATIONS = {
  item: v => [...v.items ?? [], ...(v.self?.inventory ?? []).filter(Boolean)],
  body: v => v.bodies ?? [],
  bodyOwner: v => (v.bodies ?? []).map(b => b.owner),
  tether: v => v.tethers ?? [],
  hookFlight: v => v.hookFlights ?? [],
  projectile: v => v.projectiles ?? [],
  effect: v => v.effects ?? [],
  event: v => v.events ?? [],
};
// Numeric fields named like IDs that are not match-wide counters: authored prop slots (24.4).
const NOT_COUNTERS = new Set(['propId']);
const ID_LIKE = /^(id|a|b)$|Id$/;

function declared(view) {
  const fields = new Map();
  for (const [kind, locate] of Object.entries(LOCATIONS))
    for (const record of locate(view)) fields.set(record, new Set([...fields.get(record) ?? [], ...Object.keys(WIRE_ID_FIELDS[kind])]));
  return fields;
}
function undeclaredIds(view) {
  const fields = declared(view), missing = [];
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'number' && ID_LIKE.test(key) && !NOT_COUNTERS.has(key) && !fields.get(value)?.has(key)) missing.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(view, 'view');
  return missing;
}

function compare(identity, keyed, coverage, label) {
  assert.deepEqual(Object.keys(LOCATIONS).sort(), Object.keys(WIRE_ID_FIELDS).sort(), 'every declared kind has a location');
  const restored = structuredClone(keyed);
  for (const [kind, locate] of Object.entries(LOCATIONS)) {
    const plain = locate(identity), mapped = locate(keyed), back = locate(restored);
    assert.equal(mapped.length, plain.length, `${label}: ${kind} records`);
    for (let i = 0; i < plain.length; i++) for (const [field, domain] of Object.entries(WIRE_ID_FIELDS[kind])) {
      const value = plain[i][field];
      if (typeof value !== 'number') { assert.equal(mapped[i][field], value, `${label}: ${kind}.${field}`); continue; }
      assert.equal(mapped[i][field], wire.id(value, domain), `${label}: ${kind}.${field} is the keyed ${domain} ID`);
      back[i][field] = wire.internal(mapped[i][field], domain);
      coverage.add(`${kind}.${field}`);
    }
  }
  assert.deepEqual(restored, identity, `${label}: the keyed view is the identity view with exactly the declared IDs mapped`);
  assert.deepEqual(undeclaredIds(keyed), [], `${label}: every ID-like numeric field is declared`);
  // Relations still resolve among keyed IDs alone.
  const bodies = new Set((keyed.bodies ?? []).map(b => b.id)), items = new Set((keyed.items ?? []).map(i => i.id));
  for (const body of keyed.bodies ?? []) if (body.owner.kind === 'item') assert.ok(items.has(body.owner.itemId), `${label}: body ${body.id} owner item`);
  for (const tether of keyed.tethers ?? []) assert.ok(bodies.has(tether.a) && bodies.has(tether.b), `${label}: tether ${tether.id} endpoints`);
  for (const flight of keyed.hookFlights ?? []) assert.ok(bodies.has(flight.a), `${label}: flight ${flight.id} caster body`);
  // A reload names its slot; it carries no item identity to resolve (#1131 stage 3).
  if (keyed.self?.reload) assert.deepEqual(Object.keys(keyed.self.reload), ['slot', 'until'], `${label}: reload names its slot`);
}

/**
 * What the scripted trace never captures, in one tick on an open floor: a reload in progress, a shot in
 * the air and a hook in flight.
 */
async function stagedScene(observe) {
  const content = { ...structuredClone(contentById('content-ammo-1')), discovery: false,
    roster: { contestants: ['A', 'B'], gladiators: [{ name: 'G', kit: 'hook' }] } };
  const map = { width: 800, height: 400, playableArea: openArea(800, 400, 100), obstacles: [], gates: [], hazards: [],
    spawns: [{ x: 120, y: 200 }, { x: 220, y: 300 }, { x: 600, y: 200 }], stations: [], chargers: [], sensors: [], items: [],
    traps: [], buildings: [], exit: { x: 750, y: 200 }, entry: { x: 50, y: 200 }, gaps: [] };
  const s = await createGame(17, map, content);
  try {
    const [a, b, g] = s.players;
    for (const p of s.players) { p.bot = false; p.input = {}; }
    for (const [p, at] of [[a, { x: 120, y: 200 }], [b, { x: 220, y: 300 }], [g, { x: 600, y: 200 }]]) teleport(s, p.id, at.x, at.y);
    synchronizePhysics(s);
    const pistol = (ammo, id) => ({ kind: 'weapon', weaponType: 'pistol', ammo, instanceId: id, lineageId: id });
    a.inventory[0] = pistol(5, 'a-gun'); a.reserves.pistol = 20;
    b.inventory[0] = pistol(12, 'b-gun');
    identifyItems(s);
    setInput(s, a.id, { seq: a.lastSeq + 1, slot: 0, reload: true });
    setInput(s, b.id, { seq: b.lastSeq + 1, slot: 0, attack: true, aim: 0 });
    setInput(s, g.id, { seq: g.lastSeq + 1, skill: true, aim: atan2(a.y - g.y, a.x - g.x) });
    step(s); step(s);
    const frame = snapshot(s);
    assert.ok(a.reload && frame.projectiles.length && frame.hookFlights?.length, 'the scene stages all three');
    observe(s, frame);
  } finally { disposePhysics(s); }
}

test('every view is its identity view with exactly the declared IDs keyed, and relations resolve', async () => {
  const coverage = new Set();
  let views = 0;
  const observe = (s, frame) => {
    for (const id of [...s.players.map(p => p.id), null]) {
      compare(playerView(s, frame, id), playerView(s, frame, id, wire), coverage, `tick ${frame.tick} ${id}`);
      views++;
    }
  };
  await scriptedTrace(fixture.arenas[4217], observe);
  await stagedScene(observe);
  assert.ok(views > 100);
  // The scene reaches every kind that carries an ID; a field never seen is not proven mapped.
  const expected = Object.entries(WIRE_ID_FIELDS).flatMap(([kind, fields]) => Object.keys(fields).map(f => `${kind}.${f}`));
  assert.deepEqual(expected.filter(field => !coverage.has(field)), [], 'every declared field is exercised');
});

test('the waiting yard keys its own body IDs', async () => {
  const plain = createWaiting(waitingYard()), keyed = createWaiting(waitingYard(), { wireKey: KEY });
  await Promise.all([plain.ready, keyed.ready]);
  try {
    for (const w of [plain, keyed]) {
      enterWaiting(w, 'a', 'contestant', 'warden', 'Ada'); enterWaiting(w, 'b', 'gladiator', 'striker', 'Bo');
      leaveWaiting(w, 'a'); enterWaiting(w, 'a', 'contestant', 'warden', 'Ada');
    }
    const identity = waitingView(plain, 'b'), view = waitingView(keyed, 'b');
    assert.ok(identity.bodies.length === 2);
    compare(identity, view, new Set(), 'yard');
  } finally { plain.dispose(); keyed.dispose(); }
});

test('live and delayed map payloads carry keyed item IDs, recordings internal ones, and projections use the match key', async () => {
  const arena = fixture.arenas[4217], map = structuredClone(arena.map);
  attachPortalGraph(map, structuredClone(arena.graph));
  const match = await createMatch(4217, undefined, map, contentById(fixture.content), { wireKey: KEY });
  try {
    const frame = match.snapshot();
    const recorded = match.payloadMap('recording').items, internal = match.diagnosticState.items.map(i => i.id);
    assert.deepEqual(recorded.map(i => i.id), internal, 'recordings keep internal IDs');
    for (const kind of ['live', 'spectator']) {
      const items = match.payloadMap(kind, frame).items;
      assert.deepEqual(items.map(i => i.id), internal.map(id => wire.id(id, 'item')), `${kind} map items are keyed`);
      // A client is sent each item as frames carry it (#1131 stage 3): no instance identity.
      assert.ok(items.every(item => !Object.hasOwn(item, 'instanceId') && !Object.hasOwn(item, 'lineageId')), `${kind} items carry no instance identity`);
    }
    assert.equal(match.payloadMap('live').items, match.payloadMap('live').items, 'an unchanged ground maps once');
    compare(playerView(match.diagnosticState, frame, null), match.project(frame, null), new Set(), 'directed');
  } finally { match.dispose(); }
});
