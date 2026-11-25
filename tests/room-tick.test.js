import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRoomService } from '../server/room-service.js';
import { reconstructReplayStart } from '../server/replay-start.js';
import { verifyBotCommands } from '../server/replay-verify.js';
import { packRuntimeMap } from '../server/map-pack.js';
import { createFileReplayStore } from '../server/replay-store.js';
import { readServerMessage } from '../shared/wire-schema.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { readArchive } from './helpers/recordings.js';
import { generatedMap, roomHarness } from './helpers/room-harness.js';
import { arena } from './helpers/arena.js';
import { contentById, defaultContent } from '../shared/simulation/content.ts';

async function optInRoom(durationTicks) {
  const content = structuredClone(contentById('content-ammo-1'));
  content.roster = { contestants: ['C0', 'C1'], gladiators: [{ name: 'G', kit: 'striker' }] };
  if (durationTicks !== undefined) content.durationTicks = durationTicks;
  const h = roomHarness({ devTools: 'owner', content: () => content, generateMap: seed => arena({
    cols: 6, rows: 4, seed, spawns: [{ x: 150, y: 300 }, { x: 200, y: 300 }], hunterSpawns: [{ x: 500, y: 300 }],
    obstacles: [{ id: 'wall', x: 350, y: 480, w: 80, h: 80 }],
  }).map });
  const room = await h.created(5), owner = h.joined(room, { ownerKey: room.ownerKey });
  const dev = h.joined(room, { mode: 'dev', ownerKey: room.ownerKey });
  const spectator = h.joined(room, { mode: 'spectator', ownerKey: room.ownerKey });
  owner.send({ type: 'start' });
  return { h, room, owner, dev, spectator, writer: h.writers.get(room.id) };
}

test('the opt-in room records spent inputs and keeps the same actor through a live join and resume', async () => {
  const { h, room, owner, dev, spectator, writer } = await optInRoom();
  try {
    const first = writer.frames[0];
    assert.equal(writer.header.schema, 26);
    assert.equal(writer.header.setup.portalGraph, null);
    assert.equal(writer.header.botPlannerVersion, 1);
    assert.deepEqual(first.commands.map(c => c.type), ['join', 'start']);
    assert.deepEqual([first.state.tick, first.state.physics, first.state.rng], [0, undefined, undefined]);
    assert.equal(owner.messages.find(m => m.type === 'ready').state.tick, 0);
    for (const watcher of [dev, spectator]) {
      const welcome = watcher.messages.find(m => m.type === 'welcome');
      assert.equal(welcome.ready, true, 'the room is prepared before start');
      assert.deepEqual([welcome.map, welcome.state, welcome.constants], [null, null, null]);
      const ready = watcher.messages.find(m => m.type === 'ready');
      assert.ok(ready.map);
      assert.equal(ready.state.tick, 0);
      assert.equal(watcher.messages.find(m => m.type === 'state').state.tick, 0);
    }
    const slot = first.state.players.findIndex(p => p.role === 'gladiator');
    const body = frame => frame.bodies.find(b => b.owner.kind === 'actor' && b.owner.playerIdx === slot);
    const joined = h.joined(room, { role: 'gladiator', kit: 'specter', name: 'Late join' });
    const welcome = joined.messages.find(m => m.type === 'welcome'), id = welcome.id;
    assert.equal(welcome.state.self.playerIdx, slot);
    assert.equal(welcome.state.players.find(p => p.id === id).kit, 'specter');
    room.setViewLag(joined.session.connectionId, 200);
    joined.send({ type: 'input', seq: 1, tick: 2, x: 1 });
    joined.send({ type: 'input', seq: 2, tick: 1, skill: true, interact: true, target: { kind: 'malformed' }, transit: 'rail' });
    h.wake(100);
    const [, spent, empty] = writer.frames;
    assert.equal(body(spent.state).id, body(first.state).id);
    assert.ok(spent.state.effects.some(e => e.kind === 'scan'), 'the core applied the selected live-join kit');
    assert.deepEqual(spent.commands.map(c => c.kind ?? c.type), ['join', 'join', 'viewLag', 'inputLead', 'command']);
    assert.deepEqual(spent.commands[1], { type: 'observation', kind: 'join', id, kit: 'specter' });
    assert.deepEqual(spent.commands.at(-1), { type: 'command', id, source: 'player', tick: 1, seq: 2,
      input: { aim: 0, skill: true, interact: true, target: { kind: 'unresolved' } } });
    assert.deepEqual(empty.commands, [], 'the superseded input and first-class bot commands are absent');

    joined.send({ type: 'input', seq: 90, tick: 3, x: -1 });
    const resumed = h.joined(room, { resumeKey: welcome.resumeKey });
    assert.notEqual(resumed.session.connectionId, joined.session.connectionId);
    assert.equal(resumed.session.playerId, id);
    resumed.send({ type: 'input', seq: 0, tick: 3, x: 1 });
    h.wake(50);
    const afterResume = writer.frames.at(-1);
    assert.equal(body(afterResume.state).id, body(first.state).id);
    assert.deepEqual(afterResume.commands.map(c => c.kind ?? c.type), ['resume', 'join', 'command']);
    assert.equal(afterResume.commands.at(-1).seq, 0);
    assert.equal(resumed.messages.findLast(m => m.type === 'state').state.self.lastSeq, 0);

    owner.send({ type: 'dev', action: 'pause' });
    const late = h.joined(room, { name: 'Last join' });
    owner.send({ type: 'finish' });
    await room.finalization;
    assert.deepEqual(writer.frames.at(-1).commands.map(c => [c.type, c.id]), [['join', late.session.playerId]],
      'the final frame keeps room roster metadata and only committed ticks carry the inbound queue');
  } finally { await h.service.close(); }
});

test('resimulation reproduces each committed bot command digest through a live join, resume and leave', async () => {
  // Reconstruction resolves shipped content by ID, so this room keeps the default roster.
  const content = defaultContent();
  const h = roomHarness({ devTools: 'owner', generateMap: seed => arena({
    cols: 6, rows: 4, seed, obstacles: [{ id: 'wall', x: 350, y: 480, w: 80, h: 80 }],
    spawns: content.roster.contestants.map((_, i) => ({ x: 120 + 64 * i, y: 220 })),
    hunterSpawns: content.roster.gladiators.map((_, i) => ({ x: 800, y: 240 + 100 * i })),
  }).map });
  const room = await h.created(5), owner = h.joined(room, { ownerKey: room.ownerKey });
  const dev = h.joined(room, { mode: 'dev', ownerKey: room.ownerKey });
  owner.send({ type: 'start' });
  const writer = h.writers.get(room.id);
  const run = ms => { for (let elapsed = 0; elapsed < ms; elapsed += 50) h.wake(50); };
  try {
    owner.send({ type: 'input', seq: 1, tick: 2, x: 1, attack: true });
    run(150);
    const joined = h.joined(room, { role: 'gladiator', name: 'Late join' });
    const id = joined.messages.find(m => m.type === 'welcome').id;
    room.setViewLag(joined.session.connectionId, 200);
    joined.send({ type: 'input', seq: 1, tick: room.match.tick + 2, x: -1, skill: true });
    dev.send({ type: 'dev', action: 'teleport', id: owner.session.playerId, x: 600, y: 600 });
    run(300);
    const resumed = h.joined(room, { resumeKey: joined.messages.find(m => m.type === 'welcome').resumeKey });
    resumed.send({ type: 'input', seq: 0, tick: room.match.tick + 1, x: 1 });
    run(300);
    h.service.disconnect(resumed.session);
    run(1000);
    owner.send({ type: 'finish' });
    await room.finalization;
    const archive = JSON.parse(JSON.stringify({ ...writer.header, frames: writer.frames }));
    const types = archive.frames.flatMap(f => f.commands ?? []).map(c => c.kind ?? c.type);
    for (const kind of ['join', 'resume', 'leave', 'viewLag', 'teleport', 'command']) assert.ok(types.includes(kind), `the recording holds a ${kind}`);
    assert.ok(archive.frames.some(f => f.commands?.some(c => c.type === 'command' && c.id === id)), 'the late joiner spent input');
    const committed = archive.frames.filter(f => f.botCommandDigest !== undefined);
    assert.ok(committed.length >= 30, `${committed.length} committed ticks`);
    assert.deepEqual(await verifyBotCommands(archive), { ticks: committed.length });

    const target = committed[Math.floor(committed.length / 2)], at = target.state.tick;
    const tampered = structuredClone(archive);
    tampered.frames.find(f => f.state.tick === at && f.botCommandDigest).botCommandDigest = '0'.repeat(64);
    await assert.rejects(verifyBotCommands(tampered), { name: 'RangeError', message: `Reconstructed replay bot commands differ at tick ${at}` });
    const gapped = { ...archive, frames: archive.frames.filter(f => f !== target) };
    await assert.rejects(verifyBotCommands(gapped), { message: `Replay history is gapped: tick ${at + 1} follows ${at - 1}` });
    await assert.rejects(verifyBotCommands({ ...archive, recording: { complete: false, droppedFrames: 1, endTick: at } }),
      /Replay history has missing frames/);
    const undigested = structuredClone(archive);
    delete undigested.frames.find(f => f.state.tick === at && f.botCommandDigest).botCommandDigest;
    await assert.rejects(verifyBotCommands(undigested), { message: `Missing replay bot command digest at tick ${at}` });
    await assert.rejects(verifyBotCommands({ ...archive, botPlannerVersion: 2 }), /Unsupported replay bot planner/);
    await assert.rejects(verifyBotCommands({ ...archive, schema: 23 }), /Missing replay setup|Unsupported replay schema/);
  } finally { await h.service.close(); }
});

test('a refused paused teleport still publishes the terminal frame', async () => {
  const { h, room, owner, dev, writer } = await optInRoom(1);
  try {
    owner.send({ type: 'dev', action: 'pause' });
    const id = owner.session.playerId;
    owner.send({ type: 'dev', action: 'teleport', id, x: 390, y: 520 });
    await room.finalization;
    assert.deepEqual(owner.messages.findLast(m => m.type === 'teleport'), { type: 'teleport', ok: false, id });
    for (const viewer of [owner, dev]) {
      const { state } = viewer.messages.findLast(m => m.type === 'state');
      assert.deepEqual([state.tick, state.phase], [1, 'finished']);
    }
    assert.deepEqual(writer.frames.map(f => [f.state.tick, f.state.phase]), [[0, 'live'], [1, 'finished']]);
    assert.equal(writer.finishCalls, 1);
  } finally { await h.service.close(); }
});

test('the opt-in room replies to each committed teleport and publishes a paused state on a warp', async () => {
  const { h, room, owner, writer } = await optInRoom();
  try {
    const id = owner.session.playerId;
    const teleport = (x, y) => owner.send({ type: 'dev', action: 'teleport', id, x, y });
    const replies = () => owner.messages.filter(m => m.type === 'teleport').map(m => m.ok);
    const states = () => owner.messages.filter(m => m.type === 'state');
    const point = () => states().at(-1).state.players.find(p => p.id === id);
    teleport(390, 520);
    teleport(600.4, 600);
    assert.deepEqual(replies(), [], 'admission alone sends no reply');
    h.wake(50);
    assert.deepEqual(replies(), [false, true], 'both same-actor replies come from their own warp result');
    assert.deepEqual([point().x, point().y], [600, 600]);
    assert.deepEqual(writer.frames.at(-1).commands.filter(c => c.kind === 'teleport').map(c => [c.body, c.x, c.y]),
      [[`actor:${id}`, 390, 520], [`actor:${id}`, 600, 600]]);

    owner.send({ type: 'dev', action: 'pause' });
    const before = states().length;
    teleport(390, 520);
    assert.deepEqual(replies(), [false, true, false]);
    assert.equal(states().length, before, 'a refused teleport does not publish the paused pose');
    teleport(650, 600);
    assert.deepEqual(replies(), [false, true, false, true]);
    assert.equal(states().length, before + 1);
    assert.deepEqual([point().x, point().y], [650, 600]);
    assert.equal(states().at(-1).state.tick, writer.frames.at(-1).state.tick);
    assert.deepEqual(writer.frames.map(f => f.state.tick), [0, 1, 2, 3]);
    h.wake(100);
    assert.equal(room.match.tick, 3, 'scheduler time leaves the room paused');
  } finally { await h.service.close(); }
});

test('the threaded host archives authored loot and the planner graph beside stored frames', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'room-tick-'));
  const replays = await createFileReplayStore(dir), errors = [];
  const service = createRoomService({ replays, threads: true, reportError: error => errors.push(error) });
  try {
    const map = generatedMap(9), authoredItems = structuredClone(map.items);
    const room = service.makeRoom(9, false, undefined, packRuntimeMap(map));
    await room.ready;
    assert.deepEqual(errors, []);
    const events = new Map(['welcome', 'ready', 'saved'].map(type => [type, Promise.withResolvers()]));
    const spent = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    t.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    const waitFor = async promise => {
      const result = await Promise.race([promise, aborted.promise]);
      t.signal.throwIfAborted();
      return result;
    };
    const owner = service.connect({ deliver: payload => {
      const message = readServerMessage(payload);
      events.get(message.type)?.resolve(message);
      if (message.type === 'state' && message.state.self?.lastSeq === 1) spent.resolve(message);
    } });
    service.receive(owner, { type: 'join', room: room.id, ownerKey: room.ownerKey });
    const welcome = await waitFor(events.get('welcome').promise);
    service.receive(owner, { type: 'start' });
    const ready = await waitFor(events.get('ready').promise);
    assert.equal(ready.state.tick, 0);
    const tick = ready.state.tick + 8;
    service.receive(owner, { type: 'input', tick, seq: 1, x: 1 });
    await waitFor(spent.promise);
    service.receive(owner, { type: 'finish' });
    await waitFor(events.get('saved').promise);
    const archive = readArchive(await readFile(path.join(dir, `${room.id}.json.gz`)));
    assert.equal(archive.schema, 26);
    assert.ok(archive.setup.items.length > 0, 'the generated setup includes authored loot');
    assert.deepEqual(archive.setup.items, authoredItems);
    const { owner: graphOwner } = portalGraphOf(map);
    assert.equal(archive.setup.portalGraph.encoding, 'flat-graph-1');
    assert.equal(archive.setup.portalGraph.sections.length, 5);
    assert.deepEqual(Buffer.from(archive.setup.portalGraph.sections[2], 'base64'),
      Buffer.from(graphOwner.buffer, graphOwner.byteOffset, graphOwner.byteLength));
    assert.equal(Object.hasOwn(archive.map, 'portalGraph'), false);
    assert.equal(archive.botPlannerVersion, 1);
    const first = archive.frames[0];
    assert.equal(first.state.tick, 0);
    assert.equal(first.botCommandDigest, undefined, 'the initial frame precedes any committed tick');
    const final = archive.frames.at(-1);
    assert.equal(final.state.tick, archive.frames.at(-2).state.tick, 'finishing adds a frame without advancing');
    assert.equal(final.botCommandDigest, undefined, 'the finish frame has no committed tick');
    assert.ok(archive.frames.every(frame => frame.state.players.every(player => !Object.hasOwn(player, 'route'))),
      'recorded frames omit private bot routes');
    for (const frame of archive.frames.slice(1, -1)) {
      assert.match(frame.botCommandDigest, /^[0-9a-f]{64}$/, `tick ${frame.state.tick} carries a bot digest`);
    }
    assert.equal(first.state.physics, undefined);
    assert.ok(archive.setup.items.every(item => typeof item.id === 'string'));
    assert.ok(archive.map.items.length > 0);
    assert.ok(archive.map.items.every(item => typeof item.id === 'number'), 'playback keeps initialized numeric item IDs');
    assert.deepEqual(first.commands.map(c => c.type), ['join', 'start']);
    assert.deepEqual(archive.frames.find(f => f.state.tick === tick).commands, [
      { type: 'command', id: welcome.id, source: 'player', tick, seq: 1, input: { movement: [1, 0], aim: 0 } },
    ]);
    assert.deepEqual(errors, []);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function openingArchive(t, { corridor, items } = {}) {
  const seed = 9, content = defaultContent();
  const h = roomHarness({ generateMap: () => arena({
    cols: 6, rows: 4, seed, corridor, items,
    spawns: content.roster.contestants.map((_, i) => ({ x: 120 + 64 * i, y: 220 })),
    hunterSpawns: content.roster.gladiators.map((_, i) => ({ x: 800, y: 240 + 100 * i })),
  }).map });
  t.after(() => h.service.close());
  const room = await h.created(seed), owner = h.joined(room, { ownerKey: room.ownerKey, name: 'Opening player' });
  assert.equal(room.setViewLag(owner.session.connectionId, 200), true);
  owner.send({ type: 'start' });
  const { header, frames } = h.writers.get(room.id);
  return { archive: JSON.parse(JSON.stringify({ ...header, frames })), room, playerId: owner.session.playerId };
}

test('a graph-backed replay rebuilds tick zero with the exact archived graph and authored loot', async t => {
  const items = [{ id: 'authored-pistol', kind: 'weapon', weaponType: 'pistol', x: 300, y: 350 }];
  const { archive } = await openingArchive(t, { corridor: { gaps: [1] }, items });
  assert.equal(archive.setup.portalGraph.encoding, 'flat-graph-1');
  assert.equal(archive.setup.items[0].id, 'authored-pistol');
  assert.ok(archive.map.items.length > 0);
  assert.ok(archive.map.items.every(item => typeof item.id === 'number'));
  const rebuilt = await reconstructReplayStart(archive);
  t.after(() => rebuilt.dispose());
  assert.equal(rebuilt.tick, 0);
  assert.deepEqual(rebuilt.recordingSetup(), archive.setup, 'reconstruction uploads the same graph bytes');
});

test('a graphless replay restores the opening seats and measurements and reports missing setup', async t => {
  const { archive, room, playerId } = await openingArchive(t);
  assert.equal(archive.setup.portalGraph, null);
  const openingPlayer = archive.frames[0].state.players.find(player => player.id === playerId);
  assert.ok(openingPlayer.viewLagTicks > 0 && openingPlayer.inputLeadTicks > 0);
  const rebuilt = await reconstructReplayStart(archive);
  t.after(() => rebuilt.dispose());
  assert.equal(rebuilt.tick, 0);
  assert.deepEqual(rebuilt.roster(), room.match.roster());
  assert.deepEqual(rebuilt.recordingSetup(), archive.setup);
  await assert.rejects(reconstructReplayStart(null), { name: 'RangeError', message: 'Missing or invalid replay archive' });
  await assert.rejects(reconstructReplayStart({ ...archive, setup: undefined }), /Missing replay setup\.items/);
  await assert.rejects(reconstructReplayStart({ ...archive, schema: 24, setup: { items: archive.setup.items } }),
    /Missing replay setup\.portalGraph/);
  await assert.rejects(reconstructReplayStart({ ...archive, frames: [] }), /Missing replay opening frame/);
  await assert.rejects(reconstructReplayStart({ ...archive, version: 'last-exit-0.7' }), /Unsupported replay rules/);
  await assert.rejects(reconstructReplayStart({ ...archive, contentId: 'missing-content' }), /Unknown content id/);
  await assert.rejects(reconstructReplayStart({ ...archive, botPlannerVersion: 2 }), /Unsupported replay bot planner/);
  const [start] = archive.frames;
  const badRoster = { ...start, commands: [{ type: 'start' }] };
  await assert.rejects(reconstructReplayStart({ ...archive, frames: [badRoster] }), /Unknown replay opening seat/);
  const badFrame = { ...start, state: { ...start.state, hazardX: start.state.hazardX + 1 } };
  await assert.rejects(reconstructReplayStart({ ...archive, frames: [badFrame] }), /opening frame differs at hazardX/);
});
