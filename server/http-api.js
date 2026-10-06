import { HZ, MAX_ARENA_SEED, VERSION } from '../shared/simulation/rules.ts';
import * as profiler from '../shared/profiler.ts';
import { roomSeed, roomSize, ROOM_SIZE_NAMES } from './protocol.js';
import { zoneSizeName } from '../map/live.ts';

export function installHttpApi(app, service, replays) {
  const { rooms } = service;
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION, tickRate: HZ, profiling: profiler.profiling(),
    liveRooms: [...rooms.values()].filter(r => r.started && !r.finished).length,
    emptyLiveRooms: [...rooms.values()].filter(r => r.started && !r.finished && !r.clients.size).length }));
  app.get('/api/profile', (_req, res) => { const pacing = profiler.report().find(s => s.name === 'sim.tickPacing'); res.json({ enabled: profiler.profiling(), tickRate: HZ, budgetMs: 1000 / HZ, effectiveHz: pacing?.mean ? 1000 / pacing.mean : null, frames: profiler.frameCount(), rooms: [...rooms.values()].filter(r => r.started && !r.finished).length, series: profiler.report() }); });
  app.post('/api/profile', (req, res) => { profiler.enable(req.body?.enabled !== false); res.json({ enabled: profiler.profiling() }); });
  app.post('/api/rooms', (req, res) => {
    if (!service.hasCapacity()) return res.status(429).json({ error: 'All arena slots are occupied. Try again after a match ends.' });
    const seed = roomSeed(req.body);
    if (seed === null) return res.status(400).json({ error: `Seed must be an integer from 1 to ${MAX_ARENA_SEED}.` });
    const size = roomSize(req.body);
    if (size === null) return res.status(400).json({ error: `Size must be one of ${ROOM_SIZE_NAMES.join(', ')}.` });
    const room = service.makeRoom(seed, false, size);
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
