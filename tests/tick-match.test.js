import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics, step } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { physicsRuntime } from '../shared/simulation/physics-runtime.ts';
import { matchSetup, TickMatch, createTickMatch } from '../shared/simulation/tick-match.ts';
import { emptyInput, foldChanges } from '../shared/simulation/tick-codec.ts';
import { arena } from './helpers/arena.js';

// The loader half of the live adapter (27.2 "Live adapter (3d.1)"): a small real game, mapped into the new tick's setup.
// One game serves the mapping assertions; the refusals each mutate it, so they share it too (it is only read from).

async function game() {
  const { map } = arena({ cols: 6, rows: 4, seed: 11,
    gates: [{ id: 'd0', x: 400, y: 300, w: 26, h: 54, open: false, locked: true, kind: 'door' },
      { id: 'd1', x: 700, y: 300, w: 54, h: 26, open: true, locked: false, kind: 'door' }],
    hazards: [{ x: 900, y: 100, w: 120, h: 80 }],
    stations: [{ id: 's0', x: 1000, y: 500, nodeId: '0,0' }, { id: 's1', x: 1100, y: 500, nodeId: '1,0' }],
    chargers: [{ id: 'c0', x: 300, y: 600, nodeId: '0,0' }],
    sensors: [{ id: 'n0', x: 500, y: 600 }],
    physicsProps: [{ id: 'b', profile: 'crate', x: 600, y: 600 }, { id: 'a', profile: 'crate', x: 800, y: 600, angle: 0.5 }],
    items: [{ id: 'i0', kind: 'weapon', weaponType: 'rifle', x: 300, y: 400 }, { id: 'i1', kind: 'med', x: 330, y: 400 },
      { id: 'i2', kind: 'access', x: 360, y: 400 }, { id: 'i3', kind: 'ammo', family: 'shell', count: 5, x: 390, y: 400 }],
    traps: [{ id: 't0', kind: 'mine', x: 1200, y: 300, homeX: 1200, homeY: 300, heading: 0, offset: 0, cooldown: 3, spent: false },
      { id: 't1', kind: 'spider', x: 1250, y: 300, homeX: 1260, homeY: 310, heading: 1, offset: 0, cooldown: 0, spent: false }],
    spawns: [{ x: 150, y: 300 }, { x: 200, y: 300 }], hunterSpawns: [{ x: 1000, y: 300 }] });
  // The ammo content (reloading, weapon quality), so ammo loot is valid.
  const content = structuredClone(contentById('content-ammo-1'));
  content.roster = { contestants: ['C0', 'C1'], gladiators: [{ name: 'G', kit: 'striker' }] };
  return createGame(11, map, content);
}

test('a game maps to a setup whose IDs and bodies match the old world', async () => {
  const s = await game();
  try {
    const { setup, ids } = matchSetup(s);
    // Every player is an actor with its own word, and the maps invert.
    const words = setup.state.actors.map(a => a.word);
    assert.equal(new Set(words).size, s.players.length);
    for (const p of s.players) assert.equal(ids.playerOfActor.get(ids.actorOfPlayer.get(p.id)), p.id);
    assert.deepEqual(words, [0, 1, 2 ** 32]);
    assert.equal(setup.state.actors[2].actor.kit, 'striker');
    assert.equal(setup.state.actors[0].actor.kit, null);
    assert.deepEqual(ids.gateIds.map(id => ids.gateIndex.get(id)), [0, 1]);
    assert.deepEqual(ids.stations.map(x => x.id), ['c0', 's0', 's1']);
    assert.equal(ids.transitIndex.get('s1'), 2);
    assert.deepEqual(ids.propLabels, ['a', 'b']);
    assert.deepEqual(setup.state.stations.map(x => x.station.kind), ['charging', 'transit', 'transit']);
    assert.deepEqual(setup.state.gates.map(g => g.gate.position), [[400, 300], [700, 300]]);
    assert.deepEqual(setup.state.traps[1].trap.kind, { kind: 'spider', home: [1260, 310], target: null });
    assert.equal(setup.state.traps[0].trap.readyAt, s.tick + 3);
    assert.equal(setup.tuning.items.drops.dropReserve, 48);
    assert.deepEqual(setup.bounds, [0, 0, s.map.width, s.map.height]);
    assert.deepEqual(setup.state.items.map(x => x.item.loot.kind).slice(0, 4), ['equipment', 'equipment', 'accessKey', 'ammo']);
    // Every body row is there, and the count is the old world's committed bodies (an open gate has none there).
    const kinds = new Map();
    for (const { id } of setup.bodies) kinds.set(id.kind, (kinds.get(id.kind) ?? 0) + 1);
    assert.equal(kinds.get('actor'), s.players.length);
    // Every ground item starts unplaced, with no body row: the new tick admits them at T1.
    assert.equal(kinds.get('item'), undefined);
    assert.ok(setup.state.items.every(x => x.item.unplacedAt !== null));
    assert.equal(kinds.get('prop'), 2);
    assert.equal(kinds.get('gate'), 2);
    assert.equal(kinds.get('geometry'), ids.geometryIds.length);
    const old = physicsRuntime(s).world.snapshot().bodies.filter(b => !b.spec.id.startsWith('item:')).length;
    assert.equal(setup.bodies.length - s.gates.filter(g => g.open).length, old);
    // Rows are the old row without its key word: the body kind first, the vertex count at word 20.
    for (const { row } of setup.bodies) assert.equal(row.length, 21 + 2 * row[20]);
  } finally { disposePhysics(s); }
});

test('countdowns become deadlines and windows at the game\'s tick', async () => {
  const s = await game();
  try {
    const [c, , g] = s.players;
    Object.assign(c, { attackCd: 4, railCd: 2, boost: 3, cloak: 1, stun: 0, revealed: 7, heading: 1.25 }); c.input = { sneak: true };
    Object.assign(g, { cooldown: 9 });
    const { setup } = matchSetup(s);
    const a = setup.state.actors[0].actor, b = setup.state.actors[2].actor;
    assert.deepEqual(a.deadlines, { skillReadyAt: 0, weaponReadyAt: 4, transitReadyAt: 2 });
    assert.deepEqual(a.statuses, { boost: { activeFrom: 0, expiresAt: 3 }, cloak: { activeFrom: 0, expiresAt: 1 }, reveal: { activeFrom: 0, expiresAt: 7 } });
    assert.equal(a.aim, 1.25); assert.equal(a.sneak, true);
    assert.equal(b.deadlines.skillReadyAt, 9);
    // The old tick's first step (tick 1) counts a 1 down to 0: out of effect and ready; a window [0, 1) agrees.
    assert.ok(!(a.statuses.cloak.activeFrom <= 1 && 1 < a.statuses.cloak.expiresAt));
  } finally { disposePhysics(s); }
});

test('a game that is not at its start, or holds what the state cannot, is refused', async () => {
  const s = await game();
  try {
    const [c] = s.players, r = physicsRuntime(s);
    const refused = (change, undo, pattern) => {
      change();
      try { assert.throws(() => matchSetup(s), pattern); } finally { undo(); }
    };
    refused(() => { s.phase = 'finished'; }, () => { s.phase = 'live'; }, /phase/);
    refused(() => { s.tick = 5; }, () => { s.tick = 0; }, /not its start/);
    refused(() => { s.projectiles.push({}); }, () => { s.projectiles.length = 0; }, /projectile/);
    refused(() => { r.hooks.push({}); }, () => { r.hooks.length = 0; }, /hook/);
    refused(() => { r.pendingImpulses.push({}); }, () => { r.pendingImpulses.length = 0; }, /pending/);
    refused(() => { c.charging = 'c0'; }, () => { delete c.charging; }, /charging/);
    refused(() => { c.transit = { to: 's0', arriveAt: 9 }; }, () => { delete c.transit; }, /transit/);
    refused(() => { c.reload = { slot: 0, instanceId: 1, until: 9 }; }, () => { c.reload = null; }, /reload/);
    assert.ok(matchSetup(s));
  } finally { disposePhysics(s); }
});

test('a stepped game is refused', async () => {
  const s = await game();
  try { step(s); assert.throws(() => matchSetup(s), /not its start/); } finally { disposePhysics(s); }
});

/** The same small game, run in the new tick: `fn(match, setup, ids, s)`, disposed after. */
async function live(fn, adjust = () => {}) {
  const s = await game();
  let match;
  try {
    const { setup, ids } = matchSetup(s);
    adjust(setup);
    match = new TickMatch(s, setup, ids);
    await fn(match, setup, ids, s);
  } finally { match?.dispose(); disposePhysics(s); }
}

test('the match snapshot at tick 0 is the setup state', async () => {
  await live((match, setup, ids, s) => {
    const snap = match.snapshot();
    assert.equal(snap.tick, 0);
    // Nothing is normalised: the codec round trip returns the state exactly (the wall starts at -80, as the game's does).
    assert.deepEqual(snap.state, setup.state);
    assert.equal(snap.state.hazardX, s.hazardX);
    // The dynamic bodies' poses: each actor at its record, then the props. Items have no body until T1.
    const at = (kind, id) => snap.poses.find(p => p.body.kind === kind && p.body.id === id)?.at;
    for (const e of snap.state.actors) {
      const p = s.players[[...ids.actorOfPlayer.values()].indexOf(e.word)];
      assert.ok(Math.abs(at('actor', e.word)[0] - p.x) < 1e-3 && Math.abs(at('actor', e.word)[1] - p.y) < 1e-3);
    }
    assert.ok(at('prop', 0) && at('prop', 1));
    assert.ok(!snap.poses.some(p => p.body.kind === 'item'));
  });
});

test('folding each step changes into the tick-0 snapshot reproduces the match snapshot', async () => {
  await live(match => {
    let folded = match.snapshot();
    for (let i = 1; i <= 30; i++) {
      const tick = match.step();
      assert.equal(tick.tick, i);
      folded = foldChanges(folded, tick.tick, tick.changes, tick.discontinuities);
      assert.deepEqual(folded, match.snapshot(), `tick ${i}`);
    }
    // Nothing was submitted, so each step spent only the actors' held (empty) input and the items arrived at T1.
    assert.ok(folded.state.items.every(x => x.item.unplacedAt === null));
  });
});

test('items are admitted by T1 under the reserve rule, and the match ends at its time limit', async () => {
  // Room for two loot bodies: 128 slots less 3 actors, 2 props and the reserve.
  await live(match => {
    const first = match.step();
    assert.equal(first.tick, 1);
    const placed = first.changes.items.filter(x => x.item.unplacedAt === null).length;
    assert.equal(placed, 2);
    assert.equal(first.discontinuities.filter(d => d.kind === 'placed' && d.body.kind === 'item').length, 2);
    assert.equal(match.snapshot().poses.filter(p => p.body.kind === 'item').length, 2);
    let steps = 1;
    while (match.step()) steps++;
    assert.equal(steps, 40);
    assert.equal(match.step(), null);
  }, setup => { setup.tuning.items.drops.dropReserve = 128 - 5 - 2; setup.timeLimit = 40; setup.hazardWall.graceTicks = 10; });
});

test('bot commands are accepted for a future tick, spent, and move the actor', async () => {
  await live((match, setup, ids, s) => {
    const [c] = s.players, actor = ids.actorOfPlayer.get(c.id);
    const command = (tick, seq, input) => ({ type: 'command', command: { actor, source: 'bot', tick, seq, input: { ...emptyInput(), ...input } } });
    const x = () => match.snapshot().poses.find(p => p.body.kind === 'actor' && p.body.id === actor).at[0];
    const before = x();
    // The right tick is queued; a stale tick, or a command stamped for another tick, is refused.
    assert.deepEqual(match.submit(1, [command(1, 1, { movement: [1, 0], aim: 0.5 }), command(2, 2, {})]), [true, false]);
    assert.deepEqual(match.submit(0, [command(0, 4, {})]), [false]);
    const tick = match.step();
    assert.equal(tick.inbound.length, 1);
    for (let i = 0; i < 4; i++) match.step();
    assert.ok(x() > before + 1, `${x()} did not move from ${before}`);
    assert.equal(match.acknowledged(c.id), 1);
    assert.equal(match.snapshot().state.actors[0].actor.aim, 0.5);
  });
});
