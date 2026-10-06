import { HZ, MAX_ARENA_SEED, VERSION } from '../shared/simulation/rules.ts';
import * as profiler from '../shared/profiler.ts';
import { roomSeed, roomSize, ROOM_SIZE_NAMES } from './protocol.js';
import { zoneSizeName } from '../map/live.ts';

export function installHttpApi(app, service, directory, replays) {
  const { rooms } = service;
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, tickRate: HZ, profiling: profiler.profiling(), devTools: service.devTools,
    liveRooms: [...rooms.values()].filter(r => r.started && !r.finished).length,
    emptyLiveRooms: [...rooms.values()].filter(r => r.started && !r.finished && !r.clients.size).length }));
  app.get('/api/profile', (_req, res) => { const pacing = profiler.report().find(s => s.name === 'sim.tickPacing'); res.json({ enabled: profiler.profiling(), tickRate: HZ, budgetMs: 1000 / HZ, effectiveHz: pacing?.mean ? 1000 / pacing.mean : null, frames: profiler.frameCount(), rooms: [...rooms.values()].filter(r => r.started && !r.finished).length, series: profiler.report() }); });
  app.post('/api/profile', (req, res) => { profiler.enable(req.body?.enabled !== false); res.json({ enabled: profiler.profiling() }); });
  // Open rooms' public summaries, for the lobby browser (22.5); the directory decides which are listed.
  app.get('/api/rooms', (_req, res) => res.set('Cache-Control', 'no-store').json(directory.list()));
  app.post('/api/rooms', async (req, res) => {
    if (!directory.hasCapacity()) return res.status(429).json({ error: 'All arena slots are occupied. Try again after a match ends.' });
    const seed = roomSeed(req.body);
    if (seed === null) return res.status(400).json({ error: `Seed must be an integer from 1 to ${MAX_ARENA_SEED}.` });
    const size = roomSize(req.body);
    if (size === null) return res.status(400).json({ error: `Size must be one of ${ROOM_SIZE_NAMES.join(', ')}.` });
    let room;
    try { room = await directory.createRoom(seed, false, size); }
    catch (error) { console.error(error); return res.status(500).json({ error: 'The arena could not be generated. Try again.' }); }
    if (!room) return res.status(429).json({ error: 'All arena slots are occupied. Try again after a match ends.' });
    res.status(201).json({ id: room.id, ownerKey: room.ownerKey, seed, size: zoneSizeName(size) });
  });
  app.get('/api/replays', (_req, res) => res.json(replays.list()));
  app.get('/api/replays/:id', (req, res) => {
    const download = replays.download(req.params.id);
    if (!download) return res.status(404).json({ error: 'Replay not found or still recording.' });
    res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.sendFile(download.path);
  });
}
