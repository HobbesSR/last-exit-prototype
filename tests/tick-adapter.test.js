import assert from 'node:assert/strict';
import test from 'node:test';
import { createGame, disposePhysics } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { createTickMatch } from '../shared/simulation/tick-match.ts';
import { TickBoundary, botCommand } from '../shared/simulation/tick-boundary.ts';
import { TickMirror, stepMirror } from '../shared/simulation/tick-mirror.ts';
import { arena } from './helpers/arena.js';

// The Node adapter (27.2 "Node adapter (3d.2)"): the receive boundary, bot commands and the mirror applier, on a small
// arena. The whole-match check on a generated map is tests/slow/tick-adapter-match.test.js.

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

test('a bot match on the new path holds the mirror equal to the match snapshot every tick', async () => {
  await run((s, match, mirror) => {
    assert.ok(s.players.every(p => p.bot));
    const kinds = new Set();
    assert.deepEqual(mirror.view(mirror.mirrorOf(match.snapshot())), mirror.mirrorOf(match.snapshot()));
    for (let i = 0; i < 240; i++) {
      const t = stepMirror(mirror);
      if (!t) break;
      for (const e of t.changes.events) kinds.add(e.fact.kind);
      const expected = mirror.mirrorOf(match.snapshot());
      assert.deepEqual(mirror.view(expected), expected, `tick ${t.tick}`);
    }
    // The bots acted: they moved and picked up the loot, and every command they sent was spent.
    assert.ok(kinds.has('pickup'), [...kinds].join());
    assert.ok(s.tick >= 200);
  });
});

test('player input is admitted on stamp, lead and sequence, and acknowledged once spent', async () => {
  await run((s, match, mirror) => {
    const [c] = s.players, boundary = new TickBoundary(s, match), actor = match.ids.actorOfPlayer.get(c.id);
    boundary.seat(c.id, 'join');
    c.inputLeadTicks = 3;
    // A late stamp and one beyond the lead are refused; so is a sequence at or below the last received.
    assert.equal(boundary.input(c.id, { seq: 1, tick: 0, x: 1 }), null);
    assert.equal(boundary.input(c.id, { seq: 2, tick: 5, x: 1 }), null);
    assert.equal(c.inputMarginNext, -1);
    assert.ok(boundary.input(c.id, { seq: 3, tick: 2, x: 1 }));
    // A newer input stamped earlier supersedes it (24): tick 1 spends 4, and 3 is never spent after it.
    assert.ok(boundary.input(c.id, { seq: 4, tick: 1, x: 1, aim: 0.25 }));
    assert.equal(boundary.input(c.id, { seq: 4, tick: 3 }), null);
    const x0 = c.x;
    const first = stepMirror(mirror);
    assert.deepEqual(first.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command.seq), [4]);
    assert.equal(c.lastSeq, 4);
    assert.equal(c.inputMargin, -1);
    const second = stepMirror(mirror);
    assert.deepEqual(second.inbound.filter(r => r.type === 'command' && r.command.actor === actor).map(r => r.command.seq), [3]);
    assert.equal(c.lastSeq, 4);
    // Held movement repeats, so the player keeps moving east.
    assert.ok(c.x > x0, `${c.x} did not move from ${x0}`);
    assert.equal(c.heading, 0.25);
  });
});

test('the mirror takes acknowledgment, margins and observations from the match', async () => {
  await run((s, match, mirror) => {
    const [c] = s.players, boundary = new TickBoundary(s, match);
    // Hand the seat to a connection: the join is an observation, and the core clears the bot flag.
    assert.deepEqual(boundary.seat(c.id, 'join'), { type: 'observation', observation: { kind: 'join', actor: match.ids.actorOfPlayer.get(c.id) } });
    const rows = boundary.roundTrip(c.id, 200);
    assert.deepEqual(rows.map(r => r.observation.kind), ['viewLag', 'inputLead']);
    assert.ok(boundary.input(c.id, { seq: 0, tick: 1, x: 1 }));
    stepMirror(mirror);
    assert.equal(c.bot, false);
    assert.equal(c.lastSeq, 0);
    assert.equal(c.inputMargin, 0);
    assert.equal(c.viewLagTicks, rows[0].observation.ticks);
    // An unchanged measurement records nothing.
    assert.deepEqual(boundary.roundTrip(c.id, 200), []);
    // A dev teleport warps the body before T's solve.
    boundary.teleport(c.id, [250, 500]);
    const t = stepMirror(mirror);
    assert.ok(t.discontinuities.some(d => d.kind === 'warped' && d.body.kind === 'actor'));
    assert.ok(Math.abs(c.x - 250) < 20 && Math.abs(c.y - 500) < 20, `${c.x},${c.y}`);
    // Leaving hands the seat back: the core forgets the connection's sequence at intake, and the bot's first command,
    // numbered from it, is spent on the leave's own tick.
    boundary.seat(c.id, 'leave');
    const left = stepMirror(mirror), actor = match.ids.actorOfPlayer.get(c.id);
    const bot = left.inbound.find(r => r.type === 'command' && r.command.actor === actor).command;
    assert.equal(bot.source, 'bot');
    assert.equal(c.bot, true);
    assert.equal(match.acknowledged(c.id), bot.seq);
  });
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
