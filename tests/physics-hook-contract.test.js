import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { createPhysicsGame, disposePhysics, setInput, step, snapshot, playerView } from '../shared/simulation.ts';
import { contentById } from '../shared/simulation/content.ts';
import { createReplayWriter } from '../server/replay-writer.js';
import { createReplayTimeline } from '../public/replay-timeline.js';
import { createPhysicsPrediction } from '../public/physics-prediction.js';
import { SCHEMA, recordingFit } from '../shared/recording.ts';
import { createLobby } from '../server/match.js';

function fixture() {
  const content = structuredClone(contentById('content-physics-6'));
  content.roster = { contestants: ['C'], gladiators: [{ name: 'G', kit: 'hook' }] };
  const map = { seed: 446, width: 800, height: 800,
    playableArea: { cellSize: 100, rows: Array.from({ length: 8 }, (_, y) => ({ y, runs: [[0, 8]] })) },
    modules: [], buildings: [], obstacles: [], gates: [], hazards: [], gaps: [], stations: [],
    chargers: [], sensors: [], items: [], traps: [], routes: [], nodes: [], streets: [],
    entry: { x: 80, y: 400 }, exit: { x: 750, y: 400 },
    spawns: [{ x: 250, y: 400 }], hunterSpawns: [{ x: 150, y: 400 }] };
  return { content, map };
}

test('physical content can enter an empty lobby and offer the hook without initializing a world', () => {
  for (const id of ['content-physics-5', 'content-physics-6']) {
    const lobby = createLobby(contentById(id));
    assert.equal(lobby.content.id, id);
    assert.equal(lobby.hasKit('hook'), id === 'content-physics-6');
    assert.equal(lobby.capacity('gladiator'), 3);
  }
});

test('P6 tuning rejects missing/invalid values and is detached from caller edits', async () => {
  for (const mutate of [h => delete h.speed, h => h.maxForce = Infinity,
    h => h.targetDistance = 1, h => h.durationTicks = 0.5, h => h.standoff = 600]) {
    const { content, map } = fixture(); mutate(content.hook);
    await assert.rejects(createPhysicsGame(446, map, content), /hook profile/);
  }
  const { content, map } = fixture();
  const s = await createPhysicsGame(446, map, content);
  try {
    content.hook.maxForce = 1;
    assert.equal(s.content.hook.maxForce, 6000);
    assert.ok(Object.isFrozen(s.content.hook));
    assert.equal(contentById('content-physics-5').kits.hook, undefined);
    assert.equal(contentById('content-5').hook, undefined);
  } finally { disposePhysics(s); }
});

test('schema 14 retains flight/pending/pull/cancel states through compressed recording and backward seek', async () => {
  const { content, map } = fixture();
  const s = await createPhysicsGame(446, map, content);
  const chunks = [], frames = [];
  const header = { id: 'p6', schema: SCHEMA, minSchema: 10, version: s.version,
    contentId: content.id, seed: 446, hz: 20, createdAt: 1, map: structuredClone(map) };
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const writer = createReplayWriter({ header, output, publish: async () => {}, onError: error => assert.fail(error.message) });
  try {
    s.players.forEach(p => { p.bot = false; });
    const retain = () => {
      const frame = snapshot(s);
      frames.push(JSON.parse(JSON.stringify(frame)));
      assert.equal(writer.append(frame, []), true);
    };
    retain();
    setInput(s, 'g0', { seq: 1, skill: true, aim: 0 }); step(s); retain();
    step(s); retain(); step(s); retain();
    setInput(s, 'g0', { seq: 4, skill: true }); step(s); retain();
    assert.deepEqual(frames.map(f => f.physics.hooks.map(h => h.phase)), [[], ['flying'], ['pending'], ['pulling'], []]);
    await writer.finish({ ticks: s.tick, escaped: 0 });
    const archive = JSON.parse(gunzipSync(Buffer.concat(chunks)));
    assert.equal(archive.schema, 14);
    assert.equal(recordingFit(archive), 'ok');
    const timeline = createReplayTimeline(archive);
    for (const tick of [4, 1, 3, 0, 2, 4]) assert.deepEqual(timeline.at(tick).state, frames[tick]);
    assert.equal(recordingFit({ ...header, schema: 12 }), 'ok', 'older physics archives remain readable');
  } finally { disposePhysics(s); }
});

test('P4 prediction cuts on a real P6 pull and resumes from authority after release', async () => {
  const { content, map } = fixture();
  const s = await createPhysicsGame(446, map, content);
  const prediction = await createPhysicsPrediction(map, 'c0', { clock: () => 0 });
  try {
    s.players.forEach(p => { p.bot = false; });
    prediction.correct(playerView(s, snapshot(s), 'c0'));
    setInput(s, 'g0', { seq: 1, skill: true, aim: 0 });
    for (let i = 0; i < 3; i++) { step(s); prediction.correct(playerView(s, snapshot(s), 'c0')); }
    assert.equal(prediction.stats().reason, 'tethered');
    assert.equal(prediction.stats().replayed, 0);
    setInput(s, 'g0', { seq: 4, skill: true }); step(s);
    prediction.correct(playerView(s, snapshot(s), 'c0'));
    assert.equal(prediction.stats().reason, null);
    assert.ok(Number.isFinite(prediction.value().x));
  } finally { prediction.dispose(); disposePhysics(s); }
});
