import { randomUUID, randomBytes } from 'node:crypto';
import { HZ, VERSION } from '../shared/simulation/rules.ts';
import { SCHEMA, minimumReaderForMap } from '../shared/recording.ts';
import * as profiler from '../shared/profiler.ts';
import { createMatch, createLobby } from './match.js';
import { DEFAULT_LIVE_ZONE_SIZE, zoneSizeName } from '../map/live.ts';
import { TICK_MS, MAX_CATCHUP } from './scheduler.js';
import { send, broadcast, broadcastLobby, spectatorFrame, remember, SPECTATOR_DELAY_TICKS } from './room-views.js';
import { normalizeDiagnostic, MAX_DIAGNOSTICS_PER_SESSION, MIN_DIAGNOSTIC_INTERVAL_MS } from './protocol.js';
import { trackLatency, pingSession, acceptPong, roundTripMs } from './latency.js';
export const EMPTY_ROOM_GRACE_MS = 30000;
const MAX_SPECTATORS = 24;

const ROLES = ['contestant', 'gladiator'];
const byRole = count => Object.fromEntries(ROLES.map(role => [role, count(role)]));

/**
 * The room host: admission into one room, its pre-start phase, the match, recording and finish, for
 * every room in this process. Which rooms exist, how many, and who is sent where belong to the
 * directory (room-directory.js), which sees a room only through its summary.
 * Sessions provide only deliver(serializedPayload, droppable) and close(code, reason); no socket dependency.
 * Only state frames are droppable (protocol.js `deliverable`).
 */
export function createRoomService({ replays, devTools = 'none', wallNow = Date.now, reportError = console.error,
  replayFinishTimeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const rooms = new Map();
  const finalizations = new Set();
  let closing;
  const connect = peer => trackLatency({ ...peer, connectionId: randomUUID(), playerId: null });
  /**
   * A room, open for joining at once (#258). `map` is the generated map, a promise of it (the worker, so
   * players wait in the lobby rather than for the room to exist), or absent to generate inline (the
   * fake-clock tests). Until the map arrives the room has seats but no match, and cannot start.
   * `name` lists a private room in the lobby browser (17.4 #9); the directory has checked it.
   * Null once closing.
   */
  function makeRoom(seed, matchmade = false, size = DEFAULT_LIVE_ZONE_SIZE, map, name = null) {
    if (closing) return null;
    const id = randomBytes(4).toString('hex'), lobby = createLobby();
    // `seats` answers who holds which place: the lobby's until the match exists, then the match's own.
    const room = { id, ownerKey: randomUUID(), seed, size, content: lobby.content, seats: lobby, match: null, game: null, clients: new Set(), started: false, createdAt: wallNow(), inputs: [], finished: false, debt: 0, steppedAt: 0, spectators: 0, history: [], matchmade, name, resumes: new Map() };
    rooms.set(id, room);
    if (typeof map?.then === 'function') {
      // Settles once the room has its match or has been given up, and never rejects, so it can be awaited.
      room.ready = map.then(map => openMatch(room, map), error => abandonGeneration(room, error));
    } else { openMatch(room, map); room.ready = Promise.resolve(); }
    return room;
  }
  const current = room => rooms.get(room.id) === room && !room.finished && !closing;
  function openMatch(room, map) {
    if (room.match || !current(room)) return;
    const match = createMatch(room.seed, room.size, map, room.content);
    // Nothing is recorded before the start, so every command so far is a seat the lobby gave out.
    match.seat(room.inputs);
    // `game` stays the tests' and benchmarks' escape hatch; nothing here reads it.
    Object.assign(room, { match, seats: match, game: match.diagnosticState });
    for (const session of room.clients) send(session, { type: 'ready', ...view(room, session) });
    broadcastLobby(room);
    if (room.startRequested) startMatch(room);
  }
  function abandonGeneration(room, error) {
    // Closing stops the generator, which fails what it held; that is not a fault to report.
    if (closing) return;
    reportError(error);
    if (!current(room)) return;
    room.finished = true; rooms.delete(room.id);
    for (const session of room.clients) {
      session.room = null; session.playerId = null;
      send(session, { type: 'error', message: 'The arena could not be generated. Try again.' });
    }
    room.clients.clear();
  }
  /** What a session is shown of the room's map and state: nothing until the map exists. */
  function view(room, session) {
    if (!room.match) return { map: null, state: null };
    if (session.playerId) return { map: room.match.liveMap(), state: room.match.project(room.match.snapshot(), session.playerId) };
    // A spectator is shown the delayed frame; the dev view the present one.
    const frame = session.dev ? room.match.snapshot() : spectatorFrame(room);
    return { map: room.match.spectatorMap(frame), state: room.match.project(frame, null) };
  }
  const preferredRole = (room, preference) => room.seats.preferredRole(preference);
  /** Every unfinished room's public summary: plain data, never the room, and never its owner key. */
  const summaries = () => [...rooms.values()].filter(room => !room.finished).map(room => ({
    id: room.id, name: room.name, kind: room.matchmade ? 'matchmade' : 'private', phase: room.started ? 'live' : 'lobby',
    ready: !!room.match, size: zoneSizeName(room.size), createdAt: room.createdAt,
    players: byRole(role => room.seats.roster().filter(p => p.role === role).length),
    open: byRole(role => room.seats.openPlaces(role))
  }));
  // Whether a session may open the dev view, under the server's policy (protocol.js).
  const devAllowed = owner => devTools === 'all' || devTools === 'owner' && owner;
  function replayStatus(room, status) {
    if (room.recordingStatus?.status === status || room.recordingStatus?.status === 'failed') return;
    room.recordingStatus = { type: 'replay-status', status, message: status === 'failed'
      ? 'Replay recording is unavailable. Gameplay continues.'
      : 'Replay recording has missing frames. Gameplay continues.' };
    for (const session of room.clients) send(session, room.recordingStatus);
  }
  function failRecording(room, error) {
    if (room.recordingError) return;
    room.recordingError = error instanceof Error ? error : new Error(String(error));
    try { room.writer?.abort?.(room.recordingError); } catch { /* Recording cleanup cannot stop the match. */ }
    replayStatus(room, 'failed');
    reportError(room.recordingError);
  }
  function record(room, frame) {
    const commands = room.inputs.splice(0);
    if (room.recordingError) return;
    try {
      if (room.writer.failed) return failRecording(room, room.writer.failed);
      const accepted = room.writer.append(frame, commands);
      if (room.writer.failed) failRecording(room, room.writer.failed);
      else if (accepted === false || room.writer.droppedFrames > 0) replayStatus(room, 'partial');
    } catch (error) { failRecording(room, error); }
  }
  // Diagnostics are metadata beside the recording, never a command, and never able to fail it.
  function markDiagnostic(room, marker) {
    try { if (!room.recordingError) room.writer?.mark?.(marker); } catch { /* Markers cannot stop the match. */ }
  }
  // A dev pause stops the room's clock: no tick runs, so tick order and RNG are untouched, and owed time
  // is dropped rather than caught up. The recording learns of it as one mark, with how long it lasted.
  function setPaused(room, paused) {
    if ((room.pausedAt != null) === paused) return;
    if (paused) room.pausedAt = wallNow();
    else settlePause(room);
    room.debt = 0; room.steppedAt = 0;
    const message = { type: 'paused', paused, tick: room.match.tick };
    for (const session of room.clients) send(session, message);
  }
  function settlePause(room) {
    if (room.pausedAt == null) return;
    markDiagnostic(room, { tick: room.match.tick, kind: 'pause', pausedMs: wallNow() - room.pausedAt });
    room.pausedAt = null;
  }
  function startRecording(room) {
    try {
      const map = room.match.map();
      room.writer = replays.start({ version: VERSION, schema: SCHEMA, minSchema: minimumReaderForMap(map), contentId: room.match.contentId, id: room.id, seed: room.match.seed, hz: HZ, createdAt: room.createdAt, map },
        { onError: error => failRecording(room, error) });
      if (room.recordingError) room.writer?.abort?.(room.recordingError);
    } catch (error) { failRecording(room, error); }
    record(room, room.match.snapshot());
  }
  function startMatch(room) {
    room.started = true; room.inputs.push({ type: 'start' });
    startRecording(room); remember(room, room.match.snapshot()); broadcastLobby(room);
    broadcast(room, room.match.snapshot());
  }
  function finish(room) {
    if (room.finalization) return room.finalization;
    room.finished = true; settlePause(room);
    room.finalization = (async () => {
      let deadline;
      try {
        if (!room.writer) return;
        const meta = await Promise.race([
          Promise.resolve().then(() => room.writer.finish(room.match.result())),
          new Promise((_resolve, reject) => { deadline = setTimer(() => reject(new Error('Replay finalization timed out')), replayFinishTimeoutMs); })
        ]);
        if (room.recordingError) return;
        for (const session of room.clients) send(session, { type: 'saved', replay: meta });
      } catch (error) {
        failRecording(room, error);
      } finally { if (deadline !== undefined) clearTimer(deadline); }
    })();
    // A retired room can leave the room map while its archive is still being published.
    const completion = room.finalization;
    finalizations.add(completion);
    completion.then(() => finalizations.delete(completion), () => finalizations.delete(completion));
    return completion;
  }
  function receive(session, data) {
    if (closing) return;
    if (data.type === 'pong') {
      // A fresh measurement is the only thing that changes how far a shot is rewound, so it is
      // applied here rather than re-derived every tick.
      if (acceptPong(session, data, wallNow()) && session.playerId && session.room?.match && !session.room.finished) {
        session.room.match.setViewLag(session.playerId, roundTripMs(session));
      }
      return;
    }
    if (data.type === 'join' && !session.room) {
      const room = rooms.get(data.room);
      if (!room || room.finished) return send(session, { type: 'error', message: 'This arena has ended or no longer exists. Start a new match.' });
      const owner = data.ownerKey === room.ownerKey;
      if (data.role === 'dev') {
        if (!devAllowed(owner)) return send(session, { type: 'error', message: devTools === 'owner' ? 'The dev view of this arena requires its owner key.' : 'The dev view is not enabled on this server.' });
        if (room.spectators >= MAX_SPECTATORS) return send(session, { type: 'error', message: 'This arena has no spectator capacity left.' });
        session.room = room; session.owner = owner; session.dev = true; session.devTools = true; room.spectators++; room.clients.add(session);
        // A spectator without the delay: no slot, no input authority, no recording of its own.
        send(session, { type: 'welcome', id: null, spectator: true, dev: true, devTools: true, room: room.id, owner, started: room.started, ready: !!room.match, paused: room.pausedAt != null, ...view(room, session) });
        if (room.recordingStatus) send(session, room.recordingStatus);
        return;
      }
      if (data.role === 'spectator') {
        // The directed view is unfogged, so it is a wallhack for anyone also holding a player slot.
        // Keep owner authorization even with a delayed stream; there is no public spectator UX yet.
        if (!owner) return send(session, { type: 'error', message: 'Spectating this arena requires its owner key.' });
        if (room.spectators >= MAX_SPECTATORS) return send(session, { type: 'error', message: 'This arena has no spectator capacity left.' });
        session.room = room; session.owner = owner; session.devTools = devAllowed(owner); room.spectators++; room.clients.add(session);
        // A spectator holds no slot, drives no simulation, and never starts a recording.
        send(session, { type: 'welcome', id: null, spectator: true, spectatorDelayTicks: SPECTATOR_DELAY_TICKS, room: room.id, owner, devTools: session.devTools, ready: !!room.match, paused: room.pausedAt != null, ...view(room, session) });
        if (room.recordingStatus) send(session, room.recordingStatus);
        return;
      }
      const role = room.matchmade ? preferredRole(room, data.role) : data.role === 'gladiator' ? 'gladiator' : 'contestant';
      // Validated against the content this match was pinned to, not whatever the process ships.
      const kit = room.seats.hasKit(data.kit) ? data.kit : 'warden';
      const resumedId = typeof data.resumeKey === 'string' ? room.resumes.get(data.resumeKey) : null;
      let p = resumedId && room.seats.player(resumedId);
      if (p) {
        for (const old of room.clients) if (old.playerId === p.id) { room.clients.delete(old); old.room = null; old.close(1000, 'Session resumed'); }
        p = room.seats.resume(resumedId);
      } else p = role && room.seats.join(session.connectionId, role, kit, typeof data.name === 'string' ? data.name.trim() || 'Player' : 'Player');
      if (!p) return send(session, { type: 'error', message: `No ${role} places remain in this match.` });
      session.room = room; session.owner = owner; session.devTools = devAllowed(owner); session.playerId = p.id;
      room.clients.add(session);
      for (const [key, id] of room.resumes) if (id === p.id) room.resumes.delete(key);
      const resumeKey = randomUUID(); room.resumes.set(resumeKey, p.id);
      if (room.matchmade && !room.startsAt) room.startsAt = wallNow() + 15000;
      room.inputs.push({ type: resumedId ? 'resume' : 'join', id: p.id, role: p.role, kit: p.kit, name: p.name });
      send(session, { type: 'welcome', id: p.id, resumeKey, room: room.id, owner: session.owner, devTools: session.devTools, paused: room.pausedAt != null, started: room.started, ready: !!room.match, matchmade: !!room.matchmade, startsAt: room.startsAt || null, ...view(room, session) });
      if (room.recordingStatus) send(session, room.recordingStatus);
      broadcastLobby(room);
      return;
    }
    const room = session.room;
    if (!room || room.finished) return;
    if (data.type === 'start' && session.owner && !room.started) {
      // An early start waits for the map rather than being refused.
      if (room.match) startMatch(room);
      else { room.startRequested = true; broadcastLobby(room); }
      return;
    }
    if (!room.started) return;
    // Dev controls: any session the server's dev tools policy admits, never a later-joining one it does not.
    if (data.type === 'dev' && session.devTools) {
      if (data.action === 'pause' || data.action === 'resume') setPaused(room, data.action === 'pause');
      if (data.action === 'teleport') {
        const moved = room.match.teleport(data.id, data.x, data.y);
        send(session, moved ? { type: 'teleport', ok: true, id: moved.id, x: moved.x, y: moved.y } : { type: 'teleport', ok: false, id: data.id });
        if (!moved) return;
        // Recorded with the next tick's frame, like any command between ticks.
        room.inputs.push(moved);
        // A paused room sends no frames, so show the move now rather than on resume.
        if (room.pausedAt != null) { const state = room.match.snapshot(); remember(room, state); broadcast(room, state); }
      }
      return;
    }
    if (data.type === 'diagnostic' && session.playerId) {
      // Metadata about the client's experience: never an input, never read by the simulation.
      const now = wallNow(), count = session.diagnosticCount || 0;
      if (count >= MAX_DIAGNOSTICS_PER_SESSION || now - (session.diagnosticAt ?? -Infinity) < MIN_DIAGNOSTIC_INTERVAL_MS) return;
      const marker = normalizeDiagnostic(data, room.match.tick, session.playerId);
      if (!marker) return;
      session.diagnosticCount = count + 1; session.diagnosticAt = now;
      markDiagnostic(room, marker);
      return;
    }
    if (data.type === 'input' && session.playerId) {
      const accepted = room.match.acceptInput(session.playerId, data);
      if (accepted) room.inputs.push(accepted);
    }
    if (data.type === 'finish' && session.owner) {
      room.match.end({ strand: true });
      const state = room.match.snapshot(); record(room, state);
      remember(room, state);
      broadcast(room, state);
      void finish(room);
    }
  }
  function disconnect(session) {
    session.closed = true;
    const room = session.room;
    if (!room) return;
    room.clients.delete(session);
    if (!session.playerId) { room.spectators = Math.max(0, room.spectators - 1); return; }
    if (!room.finished && room.seats.leave(session.playerId)) room.inputs.push({ type: 'leave', id: session.playerId });
    if (!room.finished) broadcastLobby(room);
  }
  function advance(elapsed, now) {
    if (closing) return;
    profiler.start('loop.tick');
    let live = 0, stepped = 0;
    for (const [id, room] of rooms) {
      for (const session of room.clients) pingSession(session, wallNow(), send);
      // The countdown runs while the map generates, but the match waits for it.
      if (room.matchmade && !room.started && room.match && room.startsAt && wallNow() >= room.startsAt && room.clients.size > 0) startMatch(room);
      if ((!room.started || room.finished) && room.clients.size === 0 && wallNow() - room.createdAt > 180000) { rooms.delete(id); continue; }
      if (!room.started || room.finished) continue;
      // Keep a short reconnect window, but abandoned playtests must not run ten minutes of bots
      // and gzip recording in the background while the owner is testing another arena.
      if (room.clients.size === 0) {
        room.emptySince ??= wallNow();
        if (wallNow() - room.emptySince >= EMPTY_ROOM_GRACE_MS) {
          room.match.end({ strand: true });
          room.inputs.push({ type: 'abandoned', reason: 'No viewers after reconnect grace' });
          record(room, room.match.snapshot()); void finish(room); continue;
        }
      } else room.emptySince = null;
      live++;
      if (room.pausedAt != null) continue;
      room.debt += elapsed;
      const owed = Math.floor(room.debt / TICK_MS);
      if (!owed) continue;
      room.debt -= owed * TICK_MS;
      if (owed > MAX_CATCHUP) profiler.count('loop.droppedTicks', owed - MAX_CATCHUP);
      const ticks = Math.min(owed, MAX_CATCHUP);
      if (room.steppedAt) profiler.observe('sim.tickPacing', (now - room.steppedAt) / ticks);
      room.steppedAt = now;
      // Offer every tick to the bounded recorder; storage pressure never delays gameplay.
      // Only the newest state reaches clients after a catch-up batch.
      let state, simulated = 0;
      for (let i = 0; i < ticks; i++) {
        state = room.match.advance(); stepped++; simulated++;
        profiler.start('loop.record'); record(room, state); profiler.stop('loop.record');
        remember(room, state);
        if (room.match.phase === 'finished') break;
      }
      // The sim fell behind wall time; tick numbers stay continuous, so only this marker shows it.
      if (owed > MAX_CATCHUP && state) markDiagnostic(room, { tick: state.tick, kind: 'server-stall', wakeMs: Math.round(elapsed), owed, simulated });
      profiler.start('loop.broadcast');
      broadcast(room, state);
      profiler.stop('loop.broadcast');
      if (room.match.phase === 'finished') void finish(room);
    }
    profiler.stop('loop.tick');
    profiler.count('loop.liveRooms', live);
    profiler.count('loop.simSteps', stepped);
    profiler.frame();
  }
  function close() {
    if (!closing) closing = (async () => {
      for (const room of rooms.values()) if (room.started && !room.finished) { room.match.end(); record(room, room.match.snapshot()); void finish(room); }
      await Promise.all([...finalizations]);
    })();
    return closing;
  }

  return { rooms, devTools, accepting: () => !closing, summaries, makeRoom, connect, receive, disconnect, advance, close };
}
