import { HZ, MAX_ARENA_SEED, MAX_PLAYER_NAME, VERSION } from '../shared/simulation/rules.ts';
import { PHYSICS_VERSION } from '../shared/simulation/physics-runtime.ts';
import * as profiler from '../shared/profiler.ts';
import {
  HTTP_ENDPOINT,
  healthResponse,
  profileResponse,
  profileToggleResponse,
  clientConfigResponse,
  roomsResponse,
  createRoomResponse,
  replaysResponse,
  httpErrorResponse,
  roomName,
  roomSeed,
  roomSize,
  MAX_ROOM_NAME,
  ROOM_SIZE_NAMES,
} from './protocol.js';
import { DEFAULT_LIVE_ZONE_SIZE, zoneSizeName } from '../map/live.ts';
import { MATCHMAKING_COUNTDOWN_MS } from './room-service.js';

/**
 * The profile endpoint's fields: this thread's series, and each threaded room's own (#1115). Rooms run here
 * pace into this thread's `sim.tickPacing`; threaded rooms' pacing is combined weighted by samples, as one
 * shared series would be.
 */
export async function profileFields(service) {
  const series = profiler.report(), roomProfiles = (await service.roomProfiles?.() ?? []).map(room => {
    const pacing = room.series.find(s => s.name === 'sim.tickPacing');
    return { ...room, effectiveHz: pacing?.mean ? 1000 / pacing.mean : null };
  });
  const paced = [series, ...roomProfiles.map(room => room.series)].map(rows => rows.find(s => s.name === 'sim.tickPacing')).filter(s => s?.mean);
  const samples = paced.reduce((sum, s) => sum + s.samples, 0);
  const mean = samples ? paced.reduce((sum, s) => sum + s.mean * s.samples, 0) / samples : 0;
  return {
    enabled: profiler.profiling(), tickRate: HZ, budgetMs: 1000 / HZ,
    effectiveHz: mean ? 1000 / mean : null, frames: profiler.frameCount(),
    rooms: service.metrics().liveRooms, series, roomProfiles,
  };
}

export function installHttpApi(app, service, directory, replays, pool = null, edge = null) {
  app.get(HTTP_ENDPOINT.HEALTH, (_req, res) => res.json(healthResponse({
    rulesVersion: VERSION, physicsVersion: PHYSICS_VERSION, tickRate: HZ, profiling: profiler.profiling(), devTools: service.devTools,
    ...service.metrics(),
    mapPool: pool?.stock() ?? null,
  })));
  app.get(HTTP_ENDPOINT.PROFILE, async (_req, res, next) => {
    try { const fields = await profileFields(service); res.json(profileResponse(fields)); } catch (error) { next(error); }
  });
  app.post(HTTP_ENDPOINT.PROFILE, (req, res) => {
    res.json(profileToggleResponse(service.setProfiling(req.body?.enabled !== false)));
  });
  // What the deploy form offers and states (22.7), from each value's owner. Defaults for a new room only:
  // a room's own labels come with its welcome, and every request is still validated here.
  app.get(HTTP_ENDPOINT.CLIENT_CONFIG, (_req, res) => res.set('Cache-Control', 'no-store').json(clientConfigResponse({
    devTools: service.devTools,
    presentation: service.defaultPresentation(),
    seed: { min: 1, max: MAX_ARENA_SEED },
    roomNameMaxLength: MAX_ROOM_NAME,
    playerNameMaxLength: MAX_PLAYER_NAME,
    sizes: ROOM_SIZE_NAMES, defaultSize: zoneSizeName(DEFAULT_LIVE_ZONE_SIZE),
    matchmakingCountdownMs: MATCHMAKING_COUNTDOWN_MS,
    webTransport: edge?.() ?? null,
  })));
  // Open rooms' public summaries, for the lobby browser (22.5); the directory decides which are listed.
  app.get(HTTP_ENDPOINT.ROOMS, (_req, res) => res.set('Cache-Control', 'no-store').json(roomsResponse(directory.list())));
  app.post(HTTP_ENDPOINT.ROOMS, (req, res) => {
    if (!directory.hasCapacity()) return res.status(429).json(httpErrorResponse('All arena slots are occupied. Try again after a match ends.'));
    const seed = roomSeed(req.body);
    if (seed === null) return res.status(400).json(httpErrorResponse(`Seed must be an integer from 1 to ${MAX_ARENA_SEED}.`));
    const size = roomSize(req.body);
    if (size === null) return res.status(400).json(httpErrorResponse(`Size must be one of ${ROOM_SIZE_NAMES.join(', ')}.`));
    const name = roomName(req.body);
    if (name === false) return res.status(400).json(httpErrorResponse(`A room name is at most ${MAX_ROOM_NAME} characters of text.`));
    if (name && directory.nameTaken(name)) return res.status(409).json(httpErrorResponse(`An open room is already called ${name}.`));
    // Answered at once: the map is ready from the pool (#266) or generates while the owner waits in the room's lobby (#258).
    const room = directory.createRoom(seed, false, size, name);
    if (!room) return res.status(429).json(httpErrorResponse('All arena slots are occupied. Try again after a match ends.'));
    res.status(201).json(createRoomResponse({ id: room.id, name, ownerKey: room.ownerKey, seed: room.seed, size: zoneSizeName(size) }));
  });
  app.get(HTTP_ENDPOINT.REPLAYS, (_req, res) => res.json(replaysResponse(replays.list())));
  app.get(`${HTTP_ENDPOINT.REPLAYS}/:id`, (req, res) => {
    const download = replays.download(req.params.id);
    if (!download) return res.status(404).json(httpErrorResponse('Replay not found or still recording.'));
    res.set({ 'Content-Type': download.lines ? 'application/x-ndjson' : 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="last-exit-${req.params.id.replace(/[^\w-]/g, '_')}.${download.lines ? 'ndjson' : 'json'}"` });
    res.sendFile(download.path);
  });
}
