import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { createTickMatch } from '../shared/simulation/tick-match.ts';
import { TickBoundary, botCommand } from '../shared/simulation/tick-boundary.ts';
import { TickMirror, stepMirror } from '../shared/simulation/tick-mirror.ts';
import { TickFrames } from '../shared/simulation/tick-frame.ts';
import { playerView } from '../shared/simulation/visibility.ts';
import { createFrameEncoder, createRecordingReader } from '../shared/recording-format.ts';
import { SCHEMA } from '../shared/recording.ts';
import { arena } from './helpers/arena.js';
import { checkFrame } from './helpers/tick-frame.js';

// The Node adapter (27.2 "Node adapter (3d.2)"): the receive boundary, bot commands and the mirror applier, on a small
// arena, and the frames on that path (27.2 "Frames (3d.3)"). The whole-match check on a generated map is
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

/** `fn(s, match, mirror)` on a fresh game, disposed after. */
async function run(fn, content) {
  const s = await game(content);
  let match;
  try {
    match = createTickMatch(s);
    await fn(s, match, new TickMirror(s, match));
  } finally { match?.dispose(); disposePhysics(s); }
}

test('a bot match on the new path holds the mirror and its frames equal to the match snapshot every tick', async () => {
  await run((s, match, mirror) => {
    assert.ok(s.players.every(p => p.bot));
    const kinds = new Set(), frames = new TickFrames(mirror), record = recordingRoundTrip();
    const words = s.players.map(p => match.ids.actorOfPlayer.get(p.id));
    assert.deepEqual(mirror.view(mirror.mirrorOf(match.snapshot())), mirror.mirrorOf(match.snapshot()));
    let previous = checkFrame(frames.frame(), match.snapshot(), 0, words), placed = 0;
    for (let i = 0; i < 240; i++) {
      const t = stepMirror(mirror);
      if (!t) break;
      frames.advance(t);
      for (const e of t.changes.events) kinds.add(e.fact.kind);
      const snap = match.snapshot(), expected = mirror.mirrorOf(snap);
      assert.deepEqual(mirror.view(expected), expected, `tick ${t.tick}`);
      const frame = frames.frame(), bodies = checkFrame(frame, snap, t.tick, words);
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
      // The recording stores it and reads it back whole; every player's view projects from it.
      assert.deepEqual(record(frame), JSON.parse(JSON.stringify(frame)), `tick ${t.tick}`);
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
  await run((s, match, mirror) => {
    const g = s.players.find(p => p.role === 'gladiator'), c = s.players.find(p => p.role === 'contestant'), gi = s.players.indexOf(g);
    const boundary = new TickBoundary(s, match), frames = new TickFrames(mirror);
    boundary.seat(g.id, 'join');
    // Beside the contestants, clear of the locked door between them and the gladiators' spawn.
    assert.ok(boundary.teleport(g.id, [c.x, c.y + 150]));
    frames.advance(stepMirror(mirror, boundary));
    let flew = 0, pulled = 0;
    for (let seq = 1; seq <= 60 && !pulled; seq++) {
      boundary.input(g.id, { seq, aim: Math.atan2(c.y - g.y, c.x - g.x), skill: seq === 1 });
      frames.advance(stepMirror(mirror, boundary));
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

test('player input waits in its buffer under 24, and only the tick about to run is submitted', async () => {
  await run((s, match, mirror) => {
    const [c] = s.players, boundary = new TickBoundary(s, match), actor = match.ids.actorOfPlayer.get(c.id);
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
    const x0 = c.x;
    assert.deepEqual(spent(stepMirror(mirror, boundary)), [4]);
    assert.equal(c.lastSeq, 4);
    assert.equal(c.inputMargin, -1);
    assert.deepEqual(spent(stepMirror(mirror, boundary)), []);
    // Held movement repeats, so the player keeps moving east.
    assert.ok(c.x > x0, `${c.x} did not move from ${x0}`);
    assert.equal(c.heading, 0.25);
  });
});

test('unstamped input is spent one a tick in arrival order, the oldest dropped on overflow', async () => {
  await run((s, match, mirror) => {
    const [c] = s.players, boundary = new TickBoundary(s, match), actor = match.ids.actorOfPlayer.get(c.id);
    boundary.seat(c.id, 'join');
    for (let seq = 1; seq <= 5; seq++) assert.ok(boundary.input(c.id, { seq, x: 1 }));
    const seqs = [];
    for (let i = 0; i < 5; i++) {
      const t = stepMirror(mirror, boundary);
      seqs.push(...t.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command.seq));
    }
    assert.deepEqual(seqs, [2, 3, 4, 5]);
  });
});

test('a seat handoff never spends what the previous connection queued', async () => {
  await run((s, match, mirror) => {
    const [c] = s.players, boundary = new TickBoundary(s, match), actor = match.ids.actorOfPlayer.get(c.id);
    const commands = t => t.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command);
    boundary.seat(c.id, 'join');
    // The first connection queues for the handoff tick and a later one, with high sequences.
    assert.ok(boundary.input(c.id, { seq: 90, tick: 1, attack: true }));
    assert.ok(boundary.input(c.id, { seq: 91, tick: 3, interact: true }));
    // A resume before tick 1: the new connection numbers from the start.
    boundary.seat(c.id, 'join');
    assert.ok(boundary.input(c.id, { seq: 1, tick: 1, x: 1 }));
    assert.deepEqual(commands(stepMirror(mirror, boundary)).map(x => x.seq), [1]);
    for (let i = 0; i < 3; i++) assert.deepEqual(commands(stepMirror(mirror, boundary)), []);
    assert.equal(match.acknowledged(c.id), 1);
    assert.equal(c.lastSeq, 1);
    // Leaving with input queued: only the bot's command is spent.
    assert.ok(boundary.input(c.id, { seq: 50, tick: s.tick + 1, attack: true }));
    boundary.seat(c.id, 'leave');
    assert.deepEqual(commands(stepMirror(mirror, boundary)).map(x => x.source), ['bot']);
    assert.equal(c.bot, true);
  });
});

test('the mirror takes acknowledgment, margins and observations from the match', async () => {
  await run((s, match, mirror) => {
    const [c, other] = s.players, boundary = new TickBoundary(s, match);
    const lagOf = rows => rows.find(r => r.observation.kind === 'viewLag')?.observation.ticks;
    // Hand the seat to a connection: the join is an observation, and the core clears the bot flag.
    assert.deepEqual(boundary.seat(c.id, 'join'), { type: 'observation', observation: { kind: 'join', actor: match.ids.actorOfPlayer.get(c.id) } });
    const rows = boundary.roundTrip(c.id, 200), committed = lagOf(rows);
    assert.deepEqual(rows.map(r => r.observation.kind), ['viewLag', 'inputLead']);
    assert.ok(boundary.input(c.id, { seq: 0, tick: 1, x: 1 }));
    stepMirror(mirror, boundary);
    assert.equal(c.bot, false);
    assert.equal(c.lastSeq, 0);
    assert.equal(c.inputMargin, 0);
    assert.equal(c.viewLagTicks, committed);
    // An unchanged measurement records nothing. A change and its correction before the next tick are both rows, since
    // each is compared with the last reported, not the committed, lag.
    assert.deepEqual(boundary.roundTrip(c.id, 200), []);
    const raised = lagOf(boundary.roundTrip(c.id, 400));
    assert.ok(raised > committed);
    assert.equal(lagOf(boundary.roundTrip(c.id, 200)), committed);
    stepMirror(mirror, boundary);
    assert.equal(c.viewLagTicks, committed);
    // A dev teleport warps the body before T's solve; one onto another player is refused, as the old dev rule refused it.
    boundary.teleport(c.id, [250, 500]);
    let t = stepMirror(mirror, boundary);
    assert.ok(t.discontinuities.some(d => d.kind === 'warped' && d.body.kind === 'actor'));
    assert.ok(Math.abs(c.x - 250) < 20 && Math.abs(c.y - 500) < 20, `${c.x},${c.y}`);
    const before = [c.x, c.y];
    boundary.teleport(c.id, [other.x, other.y]);
    t = stepMirror(mirror, boundary);
    assert.ok(!t.discontinuities.some(d => d.kind === 'warped'));
    assert.ok(Math.abs(c.x - before[0]) < 20 && Math.abs(c.y - before[1]) < 20, `${c.x},${c.y}`);
  });
});

test('each escape event reports the slots left after it', async () => {
  await run((s, match, mirror) => {
    const [a, b] = s.players.map(p => match.ids.actorOfPlayer.get(p.id)), tick = s.tick + 1;
    const fact = (actor, slots) => ({ id: 0, tick, fact: { kind: 'escaped', actor, cell: 1, slots } });
    // The tick's extraction record holds the final count; each event keeps its own.
    mirror.apply({ tick, inbound: [], discontinuities: [], discovery: { gates: [], samples: [] },
      changes: { actors: [], items: [], projectiles: [], hooks: [], gates: [], traps: [], extraction: { position: [0, 0], slots: 1 },
        hazardX: null, removed: [], poses: [], events: [fact(a, 2), fact(b, 1)] } });
    assert.deepEqual(s.events.filter(e => e.kind === 'pod_powered').map(e => [e.actor.name, e.slotsRemaining]),
      [[s.players[0].name, 2], [s.players[1].name, 1]]);
  });
});

test('with discovery off the mirror keeps no memory, as the old game keeps none', async () => {
  await run((s, match, mirror) => {
    assert.ok(s.players.every(p => p.discovery === undefined));
    for (let i = 0; i < 40; i++) {
      const t = stepMirror(mirror);
      const expected = mirror.mirrorOf(match.snapshot());
      assert.deepEqual(mirror.view(expected), expected, `tick ${t.tick}`);
    }
    // The bots keep the old game's full-map knowledge: no memory is attached.
    assert.ok(s.players.every(p => p.discovery === undefined));
  }, c => { c.discovery = false; });
});

test('bot intent maps onto the core input', async () => {
  await run((s, match) => {
    const [c] = s.players;
    const command = botCommand(s, match, c, { input: { x: 1, y: -1, aim: 2, slot: 1, drop: true, transit: 's1' }, utilitySlot: 1, discardSlot: 3 }, 1);
    assert.equal(command.source, 'bot');
    assert.equal(command.seq, 0);
    assert.deepEqual(command.input.movement, [1, -1]);
    assert.equal(command.input.utilitySlot, 1);
    // The discard outranks the selected-slot drop; transit is sent only under selectable content.
    assert.deepEqual(command.input.drop, { kind: 'slot', slot: 3 });
    assert.equal(command.input.transit, null);
  });
  await run((s, match) => {
    assert.equal(botCommand(s, match, s.players[2], { input: { transit: 's1' } }, 1).input.transit, match.ids.transitIndex.get('s1'));
  }, c => { c.transit = 'selectable'; });
});
