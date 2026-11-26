import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { createTickMatch } from '../shared/simulation/tick-match.ts';
import { botCommand, inputOf, targetOf } from '../shared/simulation/tick-boundary.ts';
import { inboundOfRecorded, recordedInbound } from '../shared/simulation/tick-record.ts';
import { emptyInput } from '../shared/simulation/tick-codec.ts';
import { sanitizeInput } from '../shared/simulation/input.ts';
import { CLIENT_MESSAGE, validateClientMessage } from '../shared/protocol.ts';
import { wireIds } from '../shared/simulation/wire-ids.ts';
import { startGame } from '../shared/simulation/tick.ts';
import { stepTick } from '../shared/simulation/tick-step.ts';
import { BodyLives } from '../shared/simulation/tick-records.ts';
import { templatesOf } from '../shared/simulation/boundary.ts';
import { TickFrames } from '../shared/simulation/tick-frame.ts';
import { playerView, projectView, viewSourceOf } from '../shared/simulation/visibility.ts';
import { createFrameEncoder, createRecordingReader } from '../shared/recording-format.ts';
import { SCHEMA } from '../shared/recording.ts';
import { arena } from './helpers/arena.js';
import { checkFrame, checkKnowledge, checkProjection, checkRecords } from './helpers/tick-frame.js';
import { now } from './helpers/scenario.js';

// The Node adapter (27.2 "Node adapter (3d.2)"): the receive boundary, bot commands and knowledge, on a small arena, and the
// frames on that path (27.2 "Frames (3d.3)"), each on an in-process session as a room runs one. What a started game did is
// read from the frame store (`now`, `stateOf`). The whole-match check on a generated map is
// tests/slow/tick-adapter-match.test.js.

/** A recording's delta store in memory: each frame encoded as the writer stores it and read back as playback reads it. */
function recordingRoundTrip() {
  const encoder = createFrameEncoder({ schema: SCHEMA }), reader = createRecordingReader();
  reader.push(`${JSON.stringify({ schema: SCHEMA, frameEncoding: 'delta-1' })}
`);
  return frame => {
    reader.push(`${encoder.encode({ entries: Object.entries(frame).map(([key, value]) => [key, JSON.stringify(value)]) }).text}
`);
    return reader.end().frames.at(-1).state;
  };
}

async function game(adjust = () => {}) {
  const { map } = arena({ cols: 6, rows: 4, seed: 11,
    gates: [{ id: 'd0', x: 400, y: 300, w: 26, h: 54, open: false, locked: true, kind: 'door' },
      { id: 'd1', x: 700, y: 300, w: 54, h: 26, open: true, locked: false, kind: 'door' }],
    stations: [{ id: 's0', x: 1000, y: 500, nodeId: '0,0' }, { id: 's1', x: 1100, y: 500, nodeId: '1,0' }],
    chargers: [{ id: 'c0', x: 300, y: 600, nodeId: '0,0' }],
    physicsProps: [{ id: 'b', profile: 'crate', x: 600, y: 600 }],
    items: [{ id: 'i0', kind: 'weapon', weaponType: 'rifle', x: 300, y: 400 }, { id: 'i1', kind: 'med', x: 330, y: 400 },
      { id: 'i2', kind: 'access', x: 360, y: 400 }, { id: 'i3', kind: 'ammo', family: 'shell', count: 5, x: 390, y: 400 }],
    traps: [{ id: 't0', kind: 'mine', x: 1200, y: 300, homeX: 1200, homeY: 300, heading: 0, offset: 0, cooldown: 3, spent: false }],
    spawns: [{ x: 150, y: 300 }, { x: 200, y: 300 }], hunterSpawns: [{ x: 500, y: 300 }] });
  const c = structuredClone(contentById('content-ammo-1'));
  c.roster = { contestants: ['C0', 'C1'], gladiators: [{ name: 'G', kit: 'striker' }] };
  adjust(c);
  return createGame(11, map, c);
}

/** `fn(s, session, step)` on a fresh game's session, disposed after; `step()` runs one tick as the room does. */
async function run(fn, content) {
  const s = await game(content);
  try {
    const session = startGame(s);
    await fn(s, session, () => stepTick({ s, ...session }));
  } finally { disposePhysics(s); }
}

test('a bot match on the new path holds the frame store records and knowledge equal to the match snapshot every tick', async () => {
  await run((s, { match, frames, projection }, step) => {
    assert.ok(s.players.every(p => p.bot));
    const kinds = new Set(), record = recordingRoundTrip();
    checkProjection(s, projection, frames.frame(), 0);
    const words = s.players.map(p => match.ids.actorOfPlayer.get(p.id));
    checkKnowledge(s, match, projection, 0);
    let previous = checkFrame(frames.frame(), match.snapshot(), 0, words), placed = 0;
    for (let i = 0; i < 240; i++) {
      const t = step();
      if (!t) break;
      for (const e of t.changes.events) kinds.add(e.fact.kind);
      const snap = match.snapshot();
      checkKnowledge(s, match, projection, t.tick);
      const frame = frames.frame(), bodies = checkFrame(frame, snap, t.tick, words);
      checkRecords(frames, snap, t.tick);
      // A body keeps its ID and generation until it is placed or warped; a placed body is marked on that tick only.
      const marked = new Map(t.discontinuities.map(d => [`${d.body.kind}:${d.body.id}`, d.kind]));
      for (const [key, body] of bodies) {
        const was = previous.get(key), marker = marked.get(key);
        assert.equal(body.discontinuity, marker === 'placed' ? 'placed' : undefined, `tick ${t.tick}: ${key}`);
        if (marker === 'placed') { placed++; if (was) assert.notEqual(body.id, was.id); }
        else if (was) {
          assert.equal(body.id, was.id, `tick ${t.tick}: ${key}`);
          assert.equal(body.generation === was.generation, marker !== 'warped', `tick ${t.tick}: ${key}`);
        }
      }
      previous = bodies;
      // The recording stores it and reads it back whole; every player's view projects from it, the core's decision equal
      // to the TypeScript rules'.
      assert.deepEqual(record(frame), JSON.parse(JSON.stringify(frame)), `tick ${t.tick}`);
      checkProjection(s, projection, frame, t.tick);
      for (const p of s.players) {
        const view = playerView(s, frame, p.id);
        assert.equal(view.self.playerIdx, s.players.indexOf(p));
        assert.equal(typeof view.hookActive, 'boolean');
      }
    }
    // The bots acted: they moved and picked up the loot, and every command they sent was spent. The loot was placed.
    assert.ok(kinds.has('pickup'), [...kinds].join());
    assert.ok(placed >= 4, `${placed} placements`);
    assert.ok(s.tick >= 200);
  });
});

test('a hook is a flight on the frame, then a tether from caster to target, and the view of its caster says so', async () => {
  await run((s, { boundary, frames }, step) => {
    const g = s.players.find(p => p.role === 'gladiator'), c = s.players.find(p => p.role === 'contestant'), gi = s.players.indexOf(g);
    boundary.seat(g.id, 'join');
    // Beside the contestants, clear of the locked door between them and the gladiators' spawn. A warp keeps the body's ID
    // and renews its generation, so a viewer does not interpolate across it.
    const bodyOfG = () => frames.frame().bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === gi);
    const before = bodyOfG();
    assert.ok(boundary.teleport(g.id, [now(s, c).x, now(s, c).y + 150]));
    step();
    const after = bodyOfG();
    assert.deepEqual([after.id, after.generation, after.discontinuity], [before.id, before.generation + 1, undefined]);
    let flew = 0, pulled = 0;
    for (let seq = 1; seq <= 60 && !pulled; seq++) {
      const [at, to] = [now(s, g), now(s, c)];
      boundary.input(g.id, { seq, aim: Math.atan2(to.y - at.y, to.x - at.x), skill: seq === 1 });
      step();
      const frame = frames.frame(), view = playerView(s, frame, g.id);
      const own = frame.bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === gi);
      for (const flight of frame.hookFlights) { flew++; assert.deepEqual([flight.a, flight.casterIdx], [own.id, gi]); }
      for (const tether of frame.tethers) {
        pulled++;
        const target = frame.bodies.find(b => b.id === tether.b);
        assert.deepEqual([tether.a, target.owner.playerIdx], [own.id, s.players.indexOf(c)]);
      }
      assert.equal(view.hookActive, frame.hookFlights.length + frame.tethers.length > 0, `tick ${s.tick}`);
      assert.equal(view.predictionTethered, frame.tethers.length > 0, `tick ${s.tick}`);
    }
    assert.ok(flew && pulled, `${flew} flights, ${pulled} tethers`);
  }, c => { c.roster.gladiators = [{ name: 'G', kit: 'hook' }]; });
});

test('a body gets a new ID each time it enters the world and a generation renewed only by a warp', () => {
  const lives = new BodyLives(), actor = { kind: 'actor', id: 7 }, item = { kind: 'item', id: 3 };
  const life = key => ({ ...lives.get(key) });
  lives.start(['actor:7']);
  assert.deepEqual(life('actor:7'), { id: 1, generation: 1 });
  lives.take([{ kind: 'placed', body: item }, { kind: 'warped', body: actor }]);
  assert.deepEqual([life('actor:7'), life('item:3'), lives.placed('item:3'), lives.placed('actor:7')],
    [{ id: 1, generation: 2 }, { id: 2, generation: 1 }, true, false]);
  // Left and entered again in one tick: a new lifetime, whatever order the markers came in.
  lives.take([{ kind: 'placed', body: actor }, { kind: 'removed', body: actor }]);
  assert.deepEqual([life('actor:7'), lives.placed('item:3')], [{ id: 3, generation: 1 }, false]);
  // Removed, then readmitted on a later tick.
  lives.take([{ kind: 'removed', body: item }]);
  assert.equal(lives.get('item:3'), undefined);
  lives.take([{ kind: 'placed', body: item }]);
  assert.deepEqual(life('item:3'), { id: 4, generation: 1 });
});

test('frames publish frozen shapes of their own, which no frame can change for another or for the loader', async () => {
  await run((s, { match, frames }, step) => {
    const template = templatesOf(s).actor.contestant.shape, radius = template.radius;
    step();
    const first = frames.frame();
    step();
    const second = new TickFrames(s, match).frame(), shape = second.bodies[0].shape;
    assert.notEqual(shape, template);
    assert.ok(Object.isFrozen(shape));
    assert.throws(() => { shape.radius = 99; }, TypeError);
    assert.equal(first.bodies[0].shape.radius, radius);
    assert.equal(template.radius, radius);
  });
});

test('player input waits in its buffer under 24, and only the tick about to run is submitted', async () => {
  await run((s, { match, boundary }, step) => {
    const [c] = s.players, actor = match.ids.actorOfPlayer.get(c.id);
    const spent = t => t.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command.seq);
    boundary.seat(c.id, 'join');
    c.inputLeadTicks = 3;
    // A late stamp and one beyond the lead are refused; so is a sequence at or below the last received.
    assert.equal(boundary.input(c.id, { seq: 1, tick: 0, x: 1 }), null);
    assert.equal(boundary.input(c.id, { seq: 2, tick: 5, x: 1 }), null);
    assert.equal(c.inputMarginNext, -1);
    assert.ok(boundary.input(c.id, { seq: 3, tick: 2, x: 1 }));
    // A newer input stamped earlier supersedes what is queued for its tick or later (24), on arrival, so the core never
    // sees seq 3, however the actor's activity turns out.
    assert.ok(boundary.input(c.id, { seq: 4, tick: 1, x: 1, aim: 0.25 }));
    assert.deepEqual(c.inputQueue.map(q => q.seq), [4]);
    assert.equal(boundary.input(c.id, { seq: 4, tick: 3 }), null);
    const x0 = now(s, c).x;
    assert.deepEqual(spent(step()), [4]);
    assert.equal(c.lastSeq, 4);
    assert.equal(c.inputMargin, -1);
    assert.deepEqual(spent(step()), []);
    // Held movement repeats, so the player keeps moving east.
    const at = now(s, c);
    assert.ok(at.x > x0, `${at.x} did not move from ${x0}`);
    assert.equal(at.heading, 0.25);
  });
});

test('unstamped input is spent one a tick in arrival order, the oldest dropped on overflow', async () => {
  await run((s, { match, boundary }, step) => {
    const [c] = s.players, actor = match.ids.actorOfPlayer.get(c.id);
    boundary.seat(c.id, 'join');
    for (let seq = 1; seq <= 5; seq++) assert.ok(boundary.input(c.id, { seq, x: 1 }));
    const seqs = [];
    for (let i = 0; i < 5; i++) {
      const t = step();
      seqs.push(...t.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command.seq));
    }
    assert.deepEqual(seqs, [2, 3, 4, 5]);
  });
});

test('a seat handoff never spends what the previous connection queued', async () => {
  await run((s, { match, boundary }, step) => {
    const [c] = s.players, actor = match.ids.actorOfPlayer.get(c.id);
    const commands = t => t.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command);
    boundary.seat(c.id, 'join');
    // The first connection queues for the handoff tick and a later one, with high sequences.
    assert.ok(boundary.input(c.id, { seq: 90, tick: 1, attack: true }));
    assert.ok(boundary.input(c.id, { seq: 91, tick: 3, interact: true }));
    // A resume before tick 1: the new connection numbers from the start.
    boundary.seat(c.id, 'join');
    assert.ok(boundary.input(c.id, { seq: 1, tick: 1, x: 1 }));
    assert.deepEqual(commands(step()).map(x => x.seq), [1]);
    for (let i = 0; i < 3; i++) assert.deepEqual(commands(step()), []);
    assert.equal(match.acknowledged(c.id), 1);
    assert.equal(c.lastSeq, 1);
    // Leaving with input queued: only the bot's command is spent.
    assert.ok(boundary.input(c.id, { seq: 50, tick: s.tick + 1, attack: true }));
    boundary.seat(c.id, 'leave');
    assert.deepEqual(commands(step()).map(x => x.source), ['bot']);
    assert.equal(c.bot, true);
  });
});

test('the boundary takes acknowledgment, margins and observations from the match', async () => {
  await run((s, { match, boundary }, step) => {
    const [c, other] = s.players;
    const lagOf = rows => rows.find(r => r.observation.kind === 'viewLag')?.observation.ticks;
    // Hand the seat to a connection: the join is an observation, and the core clears the bot flag.
    assert.deepEqual(boundary.seat(c.id, 'join'), { type: 'observation', observation: { kind: 'join', actor: match.ids.actorOfPlayer.get(c.id) } });
    const rows = boundary.roundTrip(c.id, 200), committed = lagOf(rows);
    assert.deepEqual(rows.map(r => r.observation.kind), ['viewLag', 'inputLead']);
    assert.ok(boundary.input(c.id, { seq: 0, tick: 1, x: 1 }));
    step();
    assert.equal(c.bot, false);
    assert.equal(c.lastSeq, 0);
    assert.equal(c.inputMargin, 0);
    assert.equal(now(s, c).viewLagTicks, committed);
    // An unchanged measurement records nothing. A change and its correction before the next tick are both rows, since
    // each is compared with the last reported, not the committed, lag.
    assert.deepEqual(boundary.roundTrip(c.id, 200), []);
    const raised = lagOf(boundary.roundTrip(c.id, 400));
    assert.ok(raised > committed);
    assert.equal(lagOf(boundary.roundTrip(c.id, 200)), committed);
    step();
    assert.equal(now(s, c).viewLagTicks, committed);
    // A dev teleport warps the body before T's solve; one onto another player is refused, as the old dev rule refused it.
    boundary.teleport(c.id, [250, 500]);
    let t = step(), at = now(s, c);
    assert.ok(t.discontinuities.some(d => d.kind === 'warped' && d.body.kind === 'actor'));
    assert.ok(Math.abs(at.x - 250) < 20 && Math.abs(at.y - 500) < 20, `${at.x},${at.y}`);
    const before = [at.x, at.y], onto = now(s, other);
    boundary.teleport(c.id, [onto.x, onto.y]);
    t = step();
    at = now(s, c);
    assert.ok(!t.discontinuities.some(d => d.kind === 'warped'));
    assert.ok(Math.abs(at.x - before[0]) < 20 && Math.abs(at.y - before[1]) < 20, `${at.x},${at.y}`);
  });
});

test('each escape event reports the slots left after it', async () => {
  await run((s, { match, frames }) => {
    const [a, b] = s.players.map(p => match.ids.actorOfPlayer.get(p.id)), tick = s.tick + 1;
    const fact = (actor, slots) => ({ id: 0, tick, fact: { kind: 'escaped', actor, cell: 1, slots } });
    // The tick's extraction record holds the final count; each event keeps its own.
    frames.take({ tick, inbound: [], discontinuities: [], discovery: { gates: [], samples: [] },
      changes: { actors: [], items: [], projectiles: [], hooks: [], gates: [], traps: [], extraction: { position: [0, 0], slots: 1 },
        hazardX: null, removed: [], poses: [], events: [fact(a, 2), fact(b, 1)] } });
    assert.deepEqual(frames.events().filter(e => e.kind === 'pod_powered').map(e => [e.actor.name, e.slotsRemaining]),
      [[s.players[0].name, 2], [s.players[1].name, 1]]);
  });
});

test('with discovery off the core keeps no memory to send, as the old game keeps none', async () => {
  await run((s, { match, projection }, step) => {
    assert.ok(s.players.every(p => p.discovery === undefined));
    for (let i = 0; i < 40; i++) {
      const t = step();
      checkKnowledge(s, match, projection, t.tick);
    }
    // The bots keep the old game's full-map knowledge: no memory is attached.
    assert.ok(s.players.every(p => p.discovery === undefined));
  }, c => { c.discovery = false; });
});

test('bot intent maps onto the core input', async () => {
  await run((s, { match }) => {
    const [c] = s.players;
    const command = botCommand(s, match, c, { input: { x: 1, y: -1, aim: 2, slot: 1, drop: true, transit: 's1' }, utilitySlot: 1, discardSlot: 3 }, 1);
    assert.equal(command.source, 'bot');
    assert.equal(command.seq, 0);
    assert.deepEqual(command.input.movement, [1, -1]);
    assert.equal(command.input.slot, 1);
    assert.equal(command.input.utilitySlot, 1);
    // The discard outranks the selected-slot drop; transit is sent only under selectable content.
    assert.deepEqual(command.input.drop, { kind: 'slot', slot: 3 });
    assert.equal(command.input.transit, null);
    const attack = botCommand(s, match, c, { input: { slot: 0, attack: true } }, 1);
    assert.equal(attack.input.slot, null);
    assert.equal(attack.input.attack, true);
  });
  await run((s, { match }) => {
    assert.equal(botCommand(s, match, s.players[2], { input: { transit: 's1' } }, 1).input.transit, match.ids.transitIndex.get('s1'));
  }, c => { c.transit = 'selectable'; });
});

test('a nominated target maps onto the core, through the wire key for an item, and a failed one reaches it unresolved', async () => {
  await run((s, { match }) => {
    const ids = match.ids, wire = wireIds([1, 2, 3, 4]), outward = wire.id(7, 'item');
    const target = t => inputOf(ids, { interact: true, target: t }, wire);
    assert.deepEqual(target({ kind: 'extraction' }).target, { kind: 'extraction' });
    assert.deepEqual(target({ kind: 'gate', gateIdx: 1 }).target, { kind: 'gate', id: 1 });
    assert.deepEqual(target({ kind: 'station', id: 'c0' }).target, { kind: 'station', id: ids.chargerIndex.get('c0') });
    assert.deepEqual(target({ kind: 'station', id: 's1' }).target, { kind: 'station', id: ids.transitIndex.get('s1') });
    assert.deepEqual(target({ kind: 'item', id: outward }).target, { kind: 'item', id: 7 });
    // R8 never falls through to another target: a nomination of nothing reaches the core unresolved, which rejects it.
    for (const t of [{ kind: 'gate', gateIdx: 9 }, { kind: 'station', id: 'nowhere' }]) {
      assert.deepEqual([target(t).interact, target(t).target], [true, { kind: 'unresolved' }], JSON.stringify(t));
    }
    assert.deepEqual([inputOf(ids, { interact: true }).interact, inputOf(ids, { interact: true }).target], [true, null]);
    // A failed nomination allows no other gesture, not even a valid rail destination; movement and combat stand.
    const failed = inputOf(ids, { x: 1, attack: true, interact: true, transit: 's1', target: { kind: 'station', id: 'nowhere' } }, wire);
    assert.deepEqual([failed.interact, failed.target, failed.transit, failed.movement, failed.attack], [true, { kind: 'unresolved' }, null, [1, 0], true]);
    // Unpressed, it still takes the rail away; the core asks nothing and rejects nothing.
    const quiet = inputOf(ids, { transit: 's1', target: { kind: 'gate', gateIdx: 9 } }, wire);
    assert.deepEqual([quiet.interact, quiet.target, quiet.transit], [false, { kind: 'unresolved' }, null]);
    assert.equal(inputOf(ids, { interact: true, transit: 's1' }).transit, ids.transitIndex.get('s1'), 'no nomination, so the rail stands');
    const rail = { interact: true, transit: 'nowhere', x: 1, attack: true };
    const refused = inputOf(ids, rail);
    assert.deepEqual([refused.interact, refused.transit, refused.movement, refused.attack], [false, null, [1, 0], true]);
    const automatic = inputOf(ids, rail, wire, false);
    assert.deepEqual([automatic.interact, automatic.transit], [true, null], 'automatic transit keeps the interact');
    // An item ID outside the core's range names nothing, keyed or not.
    assert.equal(targetOf(ids, { kind: 'item', id: 2 ** 32 }, wireIds()), null);
    assert.equal(targetOf(ids, { kind: 'item', id: 2 ** 20 }, wire), null);
  });
  // The wire keeps a target's shape and bounds. A malformed one is kept as `unresolved` so the core can
  // refuse the nomination without allowing rail travel.
  assert.deepEqual(sanitizeInput({ target: { kind: 'gate', gateIdx: 2, extra: 1 } }, 1).target, { kind: 'gate', gateIdx: 2 });
  for (const t of [{ kind: 'gate', gateIdx: -1 }, { kind: 'item', id: -1 }, { kind: 'item', id: 2 ** 32 }, { kind: 'station', id: '' }, { kind: 'door' }, { kind: 'unresolved' }, 'gate']) {
    const input = sanitizeInput({ x: 1, attack: true, interact: true, transit: 's1', target: t }, 1);
    assert.deepEqual([input.target, input.interact, input.transit, input.x, input.attack], [{ kind: 'unresolved' }, false, undefined, 1, true], JSON.stringify(t));
    // Unpressed, nothing is kept, a wire-sent mark included (review 1055).
    assert.equal(sanitizeInput({ transit: 's1', target: t }, 1).target, undefined, JSON.stringify(t));
  }
  await run((s, { match }) => {
    const input = inputOf(match.ids, sanitizeInput({ interact: true, target: { kind: 'door' } }, 1));
    assert.deepEqual([input.interact, input.target], [true, { kind: 'unresolved' }]);
  });
  assert.equal(sanitizeInput({ interact: true, transit: 's1' }, 1).transit, 's1');
});

test('the core rejects an unresolved nomination it is sent, and the recording names it', async () => {
  await run((s, { match }) => {
    const [c] = s.players, actor = match.ids.actorOfPlayer.get(c.id);
    const input = { ...emptyInput(), interact: true, target: { kind: 'unresolved' } };
    assert.deepEqual(match.submit(1, [{ type: 'command', command: { actor, source: 'player', tick: 1, seq: 0, input } }]), [true]);
    const t = match.step();
    assert.ok(t.changes.events.some(e => e.fact.kind === 'rejected' && e.fact.actor === actor
      && e.fact.reason.kind === 'interaction' && e.fact.reason.target?.kind === 'unresolved'), 'rejected');
    assert.deepEqual(recordedInbound(match.ids, t.inbound)[0].input, { interact: true, target: { kind: 'unresolved' } });
  });
});

test('a malformed nomination from a client reaches the core through validation and admission: rejected pressed, silent released', async () => {
  // A wire-sent mark is malformed like any other target, so released it records no press (review 1055).
  for (const [interact, target] of [[true, { kind: 'door' }], [true, { kind: 'unresolved' }], [false, { kind: 'door' }], [false, { kind: 'unresolved' }]]) {
    const label = JSON.stringify({ interact, target });
    await run((s, { match, boundary }, step) => {
      const [c] = s.players, actor = match.ids.actorOfPlayer.get(c.id);
      c.bot = false;
      const validated = validateClientMessage({ type: CLIENT_MESSAGE.INPUT, seq: 0, tick: 1, x: 1, interact, transit: 's1', target });
      assert.ok(validated.ok, validated.reason);
      const { type: _type, ...input } = validated.message;
      assert.ok(boundary.sanitizedInput(c.id, input), 'admitted');
      const t = step();
      const spent = t.inbound.find(row => row.type === 'command' && row.command.actor === actor).command.input;
      assert.deepEqual([spent.interact, spent.target, spent.transit, spent.movement], [interact, interact ? { kind: 'unresolved' } : null, null, [1, 0]], label);
      const rejected = t.changes.events.some(e => e.fact.kind === 'rejected' && e.fact.actor === actor && e.fact.reason.kind === 'interaction');
      assert.equal(rejected, interact, label);
      const recorded = recordedInbound(match.ids, t.inbound).find(r => r.id === c.id && r.type === 'command').input;
      assert.deepEqual([recorded.interact, recorded.target], interact ? [true, { kind: 'unresolved' }] : [undefined, undefined], label);
    });
  }
});

test('the core opens with the discovery the old game makes when it creates a player', async () => {
  const s = await game();
  let match;
  try {
    const sorted = xs => [...xs].sort((a, b) => a - b);
    const contestants = s.players.filter(p => p.role === 'contestant');
    // What `createGame` discovered, before the knowledge writer replaces it with the core's.
    const opened = contestants.map(p => ({ discovered: sorted(p.discovery.discovered), seen: sorted(p.discovery.seen ?? []),
      surveyed: sorted(p.discovery.surveyed ?? []), items: sorted(p.discovery.items?.keys() ?? []) }));
    assert.ok(opened.every(m => m.discovered.length > 0));
    assert.ok(opened.some(m => m.items.length > 0), 'a bot sees the map loot it starts near, bodiless as it is');
    match = createTickMatch(s);
    assert.deepEqual(contestants.map(p => {
      const m = match.memory(p.id);
      return { discovered: sorted(m.discovered), seen: sorted(m.seen), surveyed: sorted(m.surveyed), items: sorted(m.items.map(i => i.id)) };
    }), opened);
  } finally { match?.dispose(); disposePhysics(s); }
});

test('a frame records its inbound queue as the recording names it, less the commands of first-class bots', async () => {
  await run((s, { match }) => {
    const ids = match.ids, [c, , g] = s.players, word = id => ids.actorOfPlayer.get(id);
    const input = { ...emptyInput(), movement: [1, 0], attack: true, target: { kind: 'gate', id: 0 }, transit: ids.transitIndex.get('s1') };
    const recorded = recordedInbound(ids, [
      { type: 'command', command: { actor: word(c.id), source: 'player', tick: 4, seq: 9, input } },
      { type: 'command', command: { actor: word(g.id), source: 'bot', tick: 4, seq: 0, input: emptyInput() } },
      { type: 'observation', observation: { kind: 'viewLag', actor: word(c.id), ticks: 3 } },
      { type: 'observation', observation: { kind: 'join', actor: word(c.id) } },
      { type: 'observation', observation: { kind: 'teleport', body: { kind: 'actor', id: word(g.id) }, to: [10, 20] } },
      { type: 'carried', carried: { kind: 'impulse', body: { kind: 'prop', id: 0 }, impulse: [1, 2] } },
      { type: 'carried', carried: { kind: 'gateObserved', actor: word(c.id), gate: 1, open: true, locked: false } },
    ]);
    assert.deepEqual(recorded, [
      { type: 'command', id: c.id, source: 'player', tick: 4, seq: 9, input: { movement: [1, 0], attack: true, target: { kind: 'gate', id: 'd0' }, transit: 's1' } },
      { type: 'observation', kind: 'viewLag', id: c.id, ticks: 3 },
      { type: 'observation', kind: 'join', id: c.id },
      { type: 'observation', kind: 'teleport', body: `actor:${g.id}`, x: 10, y: 20 },
      { type: 'carried', kind: 'impulse', body: `prop:${ids.propLabels[0]}`, x: 1, y: 2 },
      { type: 'carried', kind: 'gateObserved', id: c.id, gate: 'd1', open: true, locked: false },
    ]);
  });
});

test('recorded command and observation rows convert back to the rows the core queued, with each relabel bot label', async () => {
  await run((s, { match }) => {
    const ids = match.ids, [c, , g] = s.players, word = id => ids.actorOfPlayer.get(id);
    const botLabel = { rank: 1, opportunistic: true };
    const rows = [
      { type: 'command', command: { actor: word(c.id), source: 'player', tick: 4, seq: 9, input: { ...emptyInput(), movement: [1, -0.5], aim: 0.25,
        target: { kind: 'gate', id: 1 }, transit: ids.transitIndex.get('s1'), drop: { kind: 'slot', slot: 2 } } } },
      { type: 'command', command: { actor: word(g.id), source: 'player', tick: 4, seq: 0, input: { ...emptyInput(), target: { kind: 'station', id: ids.chargerIndex.get('c0') } } } },
      { type: 'observation', observation: { kind: 'inputLead', actor: word(c.id), ticks: 2 } },
      { type: 'observation', observation: { kind: 'join', actor: word(g.id), kit: g.kit, botLabel } },
      { type: 'observation', observation: { kind: 'join', actor: word(c.id) } },
      { type: 'observation', observation: { kind: 'leave', actor: word(c.id) } },
      { type: 'observation', observation: { kind: 'teleport', body: { kind: 'prop', id: 0 }, to: [10, 20] } },
    ];
    const recorded = JSON.parse(JSON.stringify(recordedInbound(ids, rows)));
    assert.deepEqual(inboundOfRecorded(ids, recorded, new Map([[g.id, botLabel]])), rows);
    const carried = recordedInbound(ids, [{ type: 'carried', carried: { kind: 'killReward', actor: word(c.id) } }]);
    assert.throws(() => inboundOfRecorded(ids, carried), /carried rows are regenerated/);
    assert.throws(() => inboundOfRecorded(ids, [{ ...recorded[0], id: 'nobody' }]), /no actor for player nobody/);
  });
});

// The core's projection on an arena wider than the potential radius (1693): the view holds what is out of reach apart, so
// range, arranged effects and a same-tick finish can each disagree with the rules (#1357, review 1132).
test("the core's projection keeps arranged effects aligned and redecides when a finish strands contestants within the tick", async () => {
  const { map } = arena({ cols: 14, rows: 3, seed: 11,
    items: [{ id: 'i0', kind: 'med', x: 160, y: 290 }],
    spawns: [{ x: 150, y: 290 }, { x: 2500, y: 290 }], hunterSpawns: [{ x: 1300, y: 290 }] });
  const c = structuredClone(contentById('content-ammo-1'));
  c.roster = { contestants: ['C0', 'C1'], gladiators: [{ name: 'G', kit: 'striker' }] };
  const s = await createGame(11, map, c);
  try {
    // Two effects a scenario arranged before the start: one beside C0, one beside the far contestant, which outlives it.
    s.effects = [{ id: 900, x: 150, y: 290, kind: 'scan', radius: 30, life: 6 }, { id: 901, x: 2500, y: 290, kind: 'shock', radius: 30, life: 40 }];
    const session = startGame(s), { boundary, frames, projection } = session, step = () => stepTick({ s, ...session });
    const [near, far] = s.players;
    let frame = frames.frame();
    checkProjection(s, projection, frame, 0);
    assert.deepEqual(projection.project(frame, near.id).effects.map(e => e.id), [900], 'the far arranged effect is out of reach');
    // C0 picks up the med kit at its feet: a loot effect is made while both arranged ones are drawn.
    boundary.seat(near.id, 'join');
    let made = false;
    for (let seq = 1; seq <= 20 && !made; seq++) {
      boundary.input(near.id, { seq, interact: true });
      step();
      frame = frames.frame();
      checkProjection(s, projection, frame, s.tick);
      made = frame.effects.some(e => e.kind === 'loot');
    }
    assert.ok(made, 'the pickup made a loot effect');
    assert.ok(frame.effects.some(e => e.id === 901), 'the far arranged effect is still drawn');
    // The far contestant is out of the near one's reach: the broadcast's decision leaves it out.
    projection.decide(s.players.map(p => p.id));
    assert.ok(!projection.project(frame, near.id).players.some(p => p.playerIdx === 1));
    // The owner finishes within the tick, stranding active contestants; the final broadcast redecides. A frame captured
    // before the finish is no longer the core's to decide: projected by the rules, the far contestant is still active and
    // out of reach (review 1134).
    const before = frame;
    frames.end({ strand: true });
    // The room's path refuses it: the core decided the frame as it was before the finish (review 1136).
    assert.equal(projection.project(before, near.id), undefined, "the room's path does not decide a capture from before the finish");
    const earlier = playerView(s, before, near.id);
    assert.ok(!earlier.players.some(p => p.playerIdx === 1), 'the capture before the finish keeps its active contestant out of reach');
    assert.deepEqual(earlier, projectView(viewSourceOf(s), before, near.id));
    frame = frames.frame();
    assert.equal(frame.players[1].status, 'stranded');
    const view = projection.project(frame, near.id);
    assert.ok(view.players.some(p => p.playerIdx === 1), 'a stranded contestant is sent at any range');
    assert.deepEqual(view, playerView(s, frame, near.id));
    checkProjection(s, projection, frame, s.tick);
  } finally { disposePhysics(s); }
});
