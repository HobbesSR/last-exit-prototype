import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { createArenaServer } from '../server/index.js';

function next(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Timed out waiting for ${type}`)); }, 5000);
    function receive(raw) { const data = JSON.parse(raw); if (data.type === type) { clearTimeout(timer); ws.off('message', receive); resolve(data); } }
    ws.on('message', receive);
  });
}
test('spectators hold no slot, need the owner key, and receive the directed view', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'last-exit-spectator-'));
  const server = await createArenaServer({ replayDir: dir });
  try {
    await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.http.address().port}`;
    const room = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":9}' })).json();
    const open = async () => { const ws = new WebSocket(base.replace('http:', 'ws:')); await new Promise(resolve => ws.once('open', resolve)); return ws; };
    const denied = await open();
    const refusal = next(denied, 'error'); denied.send(JSON.stringify({ type: 'join', room: room.id, role: 'spectator' }));
    assert.match((await refusal).message, /owner key/); denied.close();
    const eye = await open();
    const welcomeEye = next(eye, 'welcome'); eye.send(JSON.stringify({ type: 'join', room: room.id, ownerKey: room.ownerKey, role: 'spectator' }));
    const we = await welcomeEye;
    assert.equal(we.id, null); assert.equal(we.spectator, true); assert.equal(we.state.directed, true);
    assert.equal(we.state.players.length, server.rooms.get(room.id).game.players.length);
    // Watching neither starts the match, consumes a slot, nor grants any authority over one.
    assert.equal(server.rooms.get(room.id).started, false);
    eye.send(JSON.stringify({ type: 'input', seq: 1, x: 1 }));
    assert.equal(server.rooms.get(room.id).game.players.every(p => p.bot), true);
    const player = await open();
    const welcomePlayer = next(player, 'welcome'); player.send(JSON.stringify({ type: 'join', room: room.id, role: 'contestant', name: 'P' }));
    const wp = await welcomePlayer;
    assert.equal(wp.state.directed, false);
    eye.send(JSON.stringify({ type: 'start' }));
    const [spectated, played] = await Promise.all([next(eye, 'state'), next(player, 'state')]);
    assert.equal(spectated.state.directed, true);
    assert.ok(spectated.state.items.length > played.state.items.length, 'directed view is unfogged');
    assert.ok(spectated.state.players.length >= played.state.players.length);
    for (let i = 0; i < 70; i++) await next(player, 'state');
    const delayed = next(eye, 'state');
    const current = next(player, 'state');
    const [spectatorFrame, playerFrame] = await Promise.all([delayed, current]);
    assert.ok(playerFrame.state.tick - spectatorFrame.state.tick >= 55, `spectator delay ${playerFrame.state.tick - spectatorFrame.state.tick} ticks`);
    eye.close(); player.close();
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
test('two clients share authority; replay preserves each recorded frame and survives restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'last-exit-test-'));
  const server = await createArenaServer({ replayDir: dir });
  let restarted;
  try {
    await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.http.address().port}`;
    assert.equal((await fetch(base + '/api/health')).status, 200);
    assert.equal((await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":-1}' })).status, 400);
    const room = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"seed":9}' })).json();
    const a = new WebSocket(base.replace('http:', 'ws:'));
    await new Promise(resolve => a.once('open', resolve));
    const welcomeA = next(a, 'welcome'); a.send(JSON.stringify({ type: 'join', room: room.id, ownerKey: room.ownerKey, name: 'A' }));
    const wa = await welcomeA; assert.equal(wa.owner, true);
    assert.equal(wa.started, false);
    const received = []; a.on('message', raw => { const data = JSON.parse(raw); if (data.type === 'state') received.push(data.state); });
    const b = new WebSocket(base.replace('http:', 'ws:'));
    await new Promise(resolve => b.once('open', resolve));
    const welcomeB = next(b, 'welcome'); b.send(JSON.stringify({ type: 'join', room: room.id, role: 'gladiator' }));
    const wb = await welcomeB; assert.notEqual(wb.id, wa.id); assert.equal(wb.owner, false);
    b.send(JSON.stringify({ type: 'finish' }));
    a.send(JSON.stringify({ type: 'start' }));
    const live = await next(a, 'state'); assert.equal(live.state.phase, 'live');
    a.send(JSON.stringify({ type: 'input', seq: 1, x: 1, hp: 99999 }));
    await next(a, 'state'); await next(a, 'state');
    const saved = next(a, 'saved'); a.send(JSON.stringify({ type: 'finish' })); const metadata = (await saved).replay;
    const replay = await (await fetch(base + `/api/replays/${room.id}`)).json();
    assert.equal(replay.frames.length, metadata.frames);
    assert.equal(replay.frames[0].state.tick, 0);
    assert.equal(replay.frames.at(-1).state.phase, 'finished');
    for (const frame of received) {
      const archived = replay.frames.find(r => r.state.tick === frame.tick && r.state.phase === frame.phase)?.state;
      assert.ok(archived, `live tick ${frame.tick} retained`);
      for (const p of frame.players) {
        // A live view is a projection of the recording: narrower for other players, never different.
        const recorded = archived.players.find(a => a.id === p.id);
        for (const [field, value] of Object.entries(p)) assert.deepEqual(value, recorded[field], `player ${p.id} field ${field}`);
        for (const field of ['path', 'input', 'inputTick', 'bot']) assert.equal(Object.hasOwn(p, field), false, `${field} withheld`);
      }
      for (const field of ['gates', 'events', 'hazardX', 'slots']) assert.deepEqual(frame[field], archived[field]);
      for (const field of ['items', 'projectiles', 'effects']) for (const visible of frame[field]) assert.deepEqual(visible, archived[field].find(item => item.id === visible.id));
    }
    const hash = createHash('sha256'); for (const frame of replay.frames) hash.update(JSON.stringify(frame) + '\n');
    assert.equal(hash.digest('hex'), metadata.sha256);
    const disk = JSON.parse(gunzipSync(await readFile(path.join(dir, `${room.id}.json.gz`))).toString());
    assert.deepEqual(disk, replay);
    a.close(); b.close(); await server.close();
    restarted = await createArenaServer({ replayDir: dir });
    await new Promise(resolve => restarted.http.listen(0, '127.0.0.1', resolve));
    const archive = await (await fetch(`http://127.0.0.1:${restarted.http.address().port}/api/replays`)).json();
    assert.equal(archive[0].id, room.id);
  } finally {
    await server.close(); if (restarted) await restarted.close();
    await rm(dir, { recursive: true, force: true });
  }
});
