import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatch } from '../server/match.js';
import { frameLine } from '../server/replay-writer.js';
import { contentById } from '../shared/simulation/content.ts';
import { inputLeadFrom } from '../shared/simulation/input.ts';
import { viewLagFrom } from '../shared/simulation/rewind.ts';
import { arena } from './helpers/arena.js';

// The room-facing match on the new tick's path (27.2 "Frames (3d.3)"), which no room uses until the cutover: what it
// records with each frame, and that its frames record and project. The adapter's own checks are tick-adapter.test.js.

async function newMatch() {
  const { map } = arena({ cols: 6, rows: 4, seed: 5, spawns: [{ x: 150, y: 300 }, { x: 200, y: 300 }], hunterSpawns: [{ x: 500, y: 300 }],
    items: [{ id: 'i0', kind: 'med', x: 300, y: 400 }] });
  const c = structuredClone(contentById('content-ammo-1'));
  c.roster = { contestants: ['C0', 'C1'], gladiators: [{ name: 'G', kit: 'striker' }] };
  return createMatch(5, 'small', map, c, { tick: 'new' });
}

test('the new path records the inbound queue each tick spent, beside the room\'s own commands', async () => {
  const match = await newMatch();
  try {
    // The lobby's seat and a lag measured before the start are the setup's.
    match.seat([{ type: 'join', id: 'p1', role: 'contestant', kit: 'warden', name: 'P' }]);
    match.setViewLag('p1', 40);
    match.start();
    // The frame the room records and publishes at the start is the core's tick 0, not the old world's (review 1049).
    let frame = match.snapshot();
    assert.deepEqual([frame.tick, frame.physics, frame.rng], [0, undefined, undefined]);
    assert.ok(frame.bodies.length > 0);
    // A measurement between the start and the first tick is that tick's observation.
    match.setViewLag('p1', 200);
    frame = match.advance();
    assert.deepEqual(match.spent().filter(c => c.type !== 'command'), [{ type: 'observation', kind: 'viewLag', id: 'p1', ticks: viewLagFrom(200) },
      ...inputLeadFrom(200) !== inputLeadFrom(40) ? [{ type: 'observation', kind: 'inputLead', id: 'p1', ticks: inputLeadFrom(200) }] : []]);
    assert.ok(match.spent().filter(c => c.type === 'command').every(c => c.source === 'bot'));
    // What the match hands out is detached.
    match.spent()[0].id = 'changed';
    assert.notEqual(match.spent()[0].id, 'changed');

    assert.ok(match.acceptInput('p1', { seq: 1, tick: match.tick + 1, x: 1, attack: true }));
    assert.equal(match.acceptInput('p1', { seq: 1, tick: match.tick + 1 }), null, 'a sequence already received is refused');
    assert.ok(Array.isArray(match.setViewLag('p1', 400)));
    assert.ok(match.teleport('p1', 600, 600));
    frame = match.advance();
    const spent = match.spent();
    // What arrived for p1, in the order the core spent it: the observations as they came, then the tick's command.
    assert.deepEqual(spent.filter(c => c.id === 'p1' || c.body === 'actor:p1'), [
      { type: 'observation', kind: 'viewLag', id: 'p1', ticks: viewLagFrom(400) },
      { type: 'observation', kind: 'inputLead', id: 'p1', ticks: inputLeadFrom(400) },
      { type: 'observation', kind: 'teleport', body: 'actor:p1', x: 600, y: 600 },
      { type: 'command', id: 'p1', source: 'player', tick: frame.tick, seq: 1, input: { movement: [1, 0], aim: 0, attack: true } },
    ]);
    assert.ok(spent.some(c => c.type === 'command' && c.source === 'bot'));
    // The teleport stood, before the solve moved the body on by its input.
    const body = frame.bodies.find(b => b.owner.kind === 'actor' && frame.players[b.owner.playerIdx].id === 'p1');
    assert.ok(Math.hypot(body.x - 600, body.y - 600) < 10, `${body.x}, ${body.y}`);

    // The frame records with its commands and projects; it has no old world state or RNG.
    assert.equal(frame.physics, undefined);
    assert.equal(frame.rng, undefined);
    const kept = (key, list) => { const json = JSON.stringify(list); return { json, bytes: Buffer.byteLength(json) }; };
    assert.deepEqual(JSON.parse(frameLine(frame, spent, kept).line).commands, spent);
    assert.equal(match.project(frame, 'p1').self.playerIdx, frame.players.findIndex(p => p.id === 'p1'));

    // A seat handed to a bot and taken back is an observation each; a bot command fills the tick between.
    assert.equal(match.leave('p1'), true);
    match.advance();
    assert.deepEqual(match.spent().filter(c => c.id === 'p1').map(c => c.kind ?? c.source), ['leave', 'bot']);
    assert.equal(match.resume('p1').id, 'p1');
    match.advance();
    assert.deepEqual(match.spent().filter(c => c.id === 'p1').map(c => c.kind ?? c.source), ['join']);
  } finally { match.dispose(); }
  assert.equal(match.snapshot().tick, 4, 'a disposed match keeps its last frame');
});
