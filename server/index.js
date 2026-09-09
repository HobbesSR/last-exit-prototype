import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createGame, joinGame, setInput, step, snapshot, playerView, HZ, VERSION, KITS } from '../shared/simulation.js';
import * as profiler from '../shared/profiler.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_SPECTATORS = 24;
const SPECTATOR_DELAY_TICKS = 60; // Three seconds at the authoritative 20 Hz rate.
const deliver = (ws, payload) => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 512 * 1024) ws.send(payload); };
const send = (ws, value) => deliver(ws, JSON.stringify(value));
const lobbyPayload = room => ({
  type: 'lobby',
  room: room.id,
  started: room.started,
  players: room.game.players
    .filter(p => !p.bot)
    .map(p => ({ id: p.id, name: p.name, role: p.role, kit: p.kit }))
});
function broadcastLobby(room) {
  const payload = JSON.stringify(lobbyPayload(room));
  for (const ws of room.clients) deliver(ws, payload);
}
export function lanUrls(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}
function printListeningUrls(host, port) {
  console.log(`Last Exit is running at http://${host}:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    const urls = lanUrls(port);
    if (urls.length) {
      console.log('LAN clients can join at:');
      for (const url of urls) console.log(`  ${url}`);
    } else {
      console.log('No LAN IPv4 address was found. Check your network connection.');
    }
  }
}
// One serialized payload per distinct view rather than per socket: players each need their own fogged
// view, every spectator shares the single directed one, and a broadcast audience must not cost a
// filter pass and a JSON.stringify per viewer.
function broadcast(room, state, view) {
  const payloads = new Map();
  const delayed = room.history?.length > SPECTATOR_DELAY_TICKS ? room.history[0] : state;
  for (const ws of room.clients) {
    const key = ws.playerId || 'spectator';
    let payload = payloads.get(key);
    if (payload === undefined) payloads.set(key, payload = JSON.stringify({ type: 'state', state: view(ws.playerId, ws.playerId ? state : delayed) }));
    deliver(ws, payload);
  }
  profiler.count('loop.viewsBuilt', payloads.size);
  profiler.count('loop.viewsSent', room.clients.size);
}
export async function createArenaServer({ replayDir = path.join(ROOT, 'replays'), profile = process.env.PROFILE === '1' } = {}) {
  profiler.enable(profile);
  await mkdir(replayDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules/phaser/dist')));
  app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules/lucide/dist/umd')));
  app.use('/vendor/sat', express.static(path.join(ROOT, 'node_modules/sat')));
  app.use('/shared', express.static(path.join(ROOT, 'shared')));
  app.use(express.static(path.join(ROOT, 'public')));
  const http = createHttpServer(app);
  const wss = new WebSocketServer({ server: http, maxPayload: 2048 });
  wss.on('error', error => { if (error.code !== 'EADDRINUSE') console.error(error); });
  const rooms = new Map();
  const archives = new Map();
  for (const file of await readdir(replayDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try { const data = JSON.parse(await readFile(path.join(replayDir, file), 'utf8')); archives.set(data.id, data); } catch { /* Ignore incomplete metadata from interrupted writes. */ }
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, tickRate: HZ, profiling: profiler.profiling() }));
  app.get('/api/profile', (_req, res) => { const pacing = profiler.report().find(s => s.name === 'sim.tickPacing'); res.json({ enabled: profiler.profiling(), tickRate: HZ, budgetMs: 1000 / HZ, effectiveHz: pacing?.mean ? 1000 / pacing.mean : null, frames: profiler.frameCount(), rooms: [...rooms.values()].filter(r => r.started && !r.finished).length, series: profiler.report() }); });
  app.post('/api/profile', (req, res) => { profiler.enable(req.body?.enabled !== false); res.json({ enabled: profiler.profiling() }); });
  app.post('/api/rooms', (req, res) => {
    if ([...rooms.values()].filter(r => !r.finished).length >= 8) return res.status(429).json({ error: 'All arena slots are occupied. Try again after a match ends.' });
    const seed = Number(req.body?.seed ?? 4217);
    if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) return res.status(400).json({ error: 'Seed must be an integer from 1 to 2147483647.' });
    const id = randomBytes(4).toString('hex');
    const ownerKey = randomUUID();
    rooms.set(id, { id, ownerKey, game: createGame(seed), clients: new Set(), started: false, createdAt: Date.now(), inputs: [], finished: false, debt: 0, steppedAt: 0, spectators: 0, history: [] });
    res.status(201).json({ id, ownerKey, seed });
  });
  app.get('/api/replays', (_req, res) => res.json([...archives.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30)));
  app.get('/api/replays/:id', (req, res) => {
    if (!archives.has(req.params.id)) return res.status(404).json({ error: 'Replay not found or still recording.' });
    res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.sendFile(path.join(replayDir, `${req.params.id}.json.gz`));
  });
  function record(room, frame) {
    const line = JSON.stringify({ state: frame, commands: room.inputs.splice(0) });
    room.hash.update(line + '\n');
    room.recorder.write((room.frameCount ? ',' : '') + line);
    room.frameCount++;
  }
  function startRecording(room) {
    room.hash = createHash('sha256'); room.frameCount = 0;
    room.recorder = createGzip();
    room.recording = pipeline(room.recorder, createWriteStream(path.join(replayDir, `${room.id}.partial`)));
    room.recording.catch(error => { room.recordError = error.message; console.error('Replay write failed:', error.message); });
    room.recorder.write(JSON.stringify({ version: VERSION, id: room.id, seed: room.game.seed, hz: HZ, createdAt: room.createdAt, map: room.game.map }).slice(0, -1) + ',"frames":[');
    record(room, snapshot(room.game));
  }
  async function finish(room) {
    if (room.finished) return;
    room.finished = true;
    room.recorder.end(']}');
    try {
      await room.recording;
      if (room.recordError) throw new Error(room.recordError);
      await rename(path.join(replayDir, `${room.id}.partial`), path.join(replayDir, `${room.id}.json.gz`));
      const meta = { id: room.id, seed: room.game.seed, createdAt: room.createdAt, ticks: room.game.tick, frames: room.frameCount, sha256: room.hash.digest('hex'), escaped: room.game.players.filter(p => p.status === 'escaped').length };
      await writeFile(path.join(replayDir, `${room.id}.meta.json`), JSON.stringify(meta));
      archives.set(room.id, meta);
      for (const ws of room.clients) send(ws, { type: 'saved', replay: meta });
    } catch (error) {
      for (const ws of room.clients) send(ws, { type: 'error', message: 'Replay could not be saved.' });
      console.error(error);
    }
  }
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return ws.close(1008, 'Origin rejected'); } catch { return ws.close(1008); }
    }
    // A connection is a viewer first; playerId stays null unless it actually claims a slot.
    ws.connectionId = randomUUID(); ws.playerId = null; ws.windowStart = Date.now(); ws.messages = 0;
    ws.on('message', raw => {
      if (Date.now() - ws.windowStart > 1000) { ws.windowStart = Date.now(); ws.messages = 0; }
      if (++ws.messages > 70) return ws.close(1008, 'Input rate exceeded');
      let data;
      try { data = JSON.parse(raw); } catch { return ws.close(1008, 'Invalid message'); }
      if (!data || typeof data !== 'object') return;
      if (data.type === 'join' && !ws.room) {
        const room = rooms.get(data.room);
        if (!room || room.finished) return send(ws, { type: 'error', message: 'This arena has ended or no longer exists. Start a new match.' });
        const owner = data.ownerKey === room.ownerKey;
        if (data.role === 'spectator') {
          // The directed view is unfogged, so it is a wallhack for anyone also holding a player slot.
          // Until spectator streams are delayed, only the room owner may open one.
          if (!owner) return send(ws, { type: 'error', message: 'Spectating this arena requires its owner key.' });
          if (room.spectators >= MAX_SPECTATORS) return send(ws, { type: 'error', message: 'This arena has no spectator capacity left.' });
          ws.room = room; ws.owner = owner; room.spectators++; room.clients.add(ws);
          // A spectator holds no slot, drives no simulation, and never starts a recording.
          const frame = room.history.length > SPECTATOR_DELAY_TICKS ? room.history[0] : snapshot(room.game);
          return send(ws, { type: 'welcome', id: null, spectator: true, spectatorDelayTicks: SPECTATOR_DELAY_TICKS, room: room.id, owner, map: room.game.map, state: playerView(room.game, frame, null) });
        }
        const role = data.role === 'gladiator' ? 'gladiator' : 'contestant';
        const kit = Object.hasOwn(KITS, data.kit) ? data.kit : 'warden';
        const p = joinGame(room.game, ws.connectionId, role, kit, typeof data.name === 'string' ? data.name.trim() || 'Player' : 'Player');
        if (!p) return send(ws, { type: 'error', message: `No ${role} places remain in this match.` });
        ws.room = room; ws.owner = owner; ws.playerId = p.id;
        room.clients.add(ws);
        room.inputs.push({ type: 'join', id: p.id, role, kit, name: p.name });
        send(ws, { type: 'welcome', id: p.id, room: room.id, owner: ws.owner, started: room.started, map: room.game.map, state: playerView(room.game, snapshot(room.game), p.id) });
        broadcastLobby(room);
        return;
      }
      const room = ws.room;
      if (!room || room.finished) return;
      if (data.type === 'start' && ws.owner && !room.started) {
        room.started = true;
        room.inputs.push({ type: 'start' });
        startRecording(room);
        broadcastLobby(room);
        broadcast(room, snapshot(room.game), (id, frame) => playerView(room.game, frame, id));
        return;
      }
      if (!room.started) return;
      if (data.type === 'input' && ws.playerId && setInput(room.game, ws.playerId, data)) room.inputs.push({ type: 'input', id: ws.playerId, input: room.game.players.find(p => p.id === ws.playerId).input, seq: data.seq });
      if (data.type === 'finish' && ws.owner) {
        room.game.phase = 'finished';
        for (const p of room.game.players) if (p.status === 'active' && p.role === 'contestant') p.status = 'stranded';
        const state = snapshot(room.game); record(room, state);
        room.history.push(state);
        while (room.history.length > SPECTATOR_DELAY_TICKS + 2) room.history.shift();
        broadcast(room, state, (id, frame) => playerView(room.game, frame, id));
        void finish(room);
      }
    });
    ws.on('close', () => {
      const room = ws.room;
      if (!room) return;
      room.clients.delete(ws);
      if (!ws.playerId) { room.spectators = Math.max(0, room.spectators - 1); return; }
      const p = room.game.players.find(p => p.id === ws.playerId);
      if (p && !room.finished) { p.bot = true; p.input = {}; room.inputs.push({ type: 'leave', id: p.id }); }
      if (!room.finished) broadcastLobby(room);
    });
    ws.on('error', () => {});
  });
  // Timer resolution, not simulation cost, sets the real tick rate: a bare setInterval(1000 / HZ) is
  // rounded up to the platform's timer granularity, which on Windows is about 15.6 ms and turned a
  // 20 Hz match into a 16 Hz one running 25% slow. Wake far more often than a tick and advance each
  // room by however many whole ticks elapsed real time has earned, so the simulation clock tracks
  // the wall clock regardless of how coarsely the platform can wake us.
  const TICK_MS = 1000 / HZ;
  const WAKE_MS = Math.max(1, Math.round(TICK_MS / 8));
  const MAX_CATCHUP = 5; // Ticks per wake. Bounds recovery so a stall cannot spiral into a burst.
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const elapsed = now - previous; previous = now;
    profiler.observe('loop.wake', elapsed);
    profiler.start('loop.tick');
    let live = 0, stepped = 0;
    for (const [id, room] of rooms) {
      if ((!room.started || room.finished) && room.clients.size === 0 && Date.now() - room.createdAt > 180000) { rooms.delete(id); continue; }
      if (!room.started || room.finished) continue;
      live++;
      room.debt += elapsed;
      // Pause simulation advancement under disk backpressure rather than dropping replay ticks.
      if (room.recorder.writableNeedDrain) { profiler.count('loop.backpressureSkips'); continue; }
      const owed = Math.floor(room.debt / TICK_MS);
      if (!owed) continue;
      room.debt -= owed * TICK_MS;
      if (owed > MAX_CATCHUP) profiler.count('loop.droppedTicks', owed - MAX_CATCHUP);
      const ticks = Math.min(owed, MAX_CATCHUP);
      if (room.steppedAt) profiler.observe('sim.tickPacing', (now - room.steppedAt) / ticks);
      room.steppedAt = now;
      // Every simulated tick is recorded; only the newest reaches clients, so a catch-up batch
      // costs one broadcast rather than several stale ones.
      let state;
      for (let i = 0; i < ticks; i++) {
        step(room.game);
        state = snapshot(room.game); stepped++;
        profiler.start('loop.record'); record(room, state); profiler.stop('loop.record');
        if (room.game.phase === 'finished') break;
      }
      profiler.start('loop.broadcast');
      room.history.push(state);
      while (room.history.length > SPECTATOR_DELAY_TICKS + 2) room.history.shift();
      broadcast(room, state, (id, frame) => playerView(room.game, frame, id));
      profiler.stop('loop.broadcast');
      if (room.game.phase === 'finished') void finish(room);
    }
    profiler.stop('loop.tick');
    profiler.count('loop.liveRooms', live);
    profiler.count('loop.simSteps', stepped);
    profiler.frame();
  }, WAKE_MS);
  async function close() {
    clearInterval(timer);
    clearInterval(summary);
    for (const ws of wss.clients) ws.terminate();
    for (const room of rooms.values()) if (room.started && !room.finished) { room.game.phase = 'finished'; record(room, snapshot(room.game)); await finish(room); }
    await new Promise(resolve => wss.close(resolve));
    if (http.listening) await new Promise(resolve => http.close(resolve));
  }
  const summary = setInterval(() => {
    if (!profiler.profiling() || !profiler.frameCount()) return;
    console.log(`\nprofile: ${profiler.frameCount()} loop frames, budget ${(1000 / HZ).toFixed(1)} ms${profiler.format()}`);
  }, 10000);
  summary.unref?.();
  return { http, close, rooms, profiler };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arena = await createArenaServer();
  const lan = process.argv.includes('--lan') || process.env.LAN === '1';
  const host = process.env.HOST || (lan ? '0.0.0.0' : '127.0.0.1');
  const firstPort = Number(process.env.PORT || 3000);
  let port = firstPort;
  arena.http.on('error', error => {
    if (error.code === 'EADDRINUSE' && port < firstPort + 20) arena.http.listen(++port, host);
    else { console.error(error); process.exit(1); }
  });
  arena.http.on('listening', () => printListeningUrls(host, port));
  arena.http.listen(port, host);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await arena.close(); process.exit(0); });
}
