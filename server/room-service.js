import { randomUUID, randomBytes } from 'node:crypto';
import { HZ, VERSION, KITS } from '../shared/simulation/rules.js';
import * as profiler from '../shared/profiler.js';
import { createMatch } from './match.js';
import { TICK_MS, MAX_CATCHUP } from './scheduler.js';
import { send, broadcast, broadcastLobby, spectatorFrame, remember, SPECTATOR_DELAY_TICKS } from './room-views.js';
export const EMPTY_ROOM_GRACE_MS = 30000;
const MAX_SPECTATORS = 24;

// Sessions provide only deliver(serializedPayload) and close(code, reason); no socket dependency.
export function createRoomService({ replays, wallNow = Date.now, reportError = console.error }) {
  const rooms = new Map();
  const finalizations = new Set();
  let closing;
  const hasCapacity = () => !closing && [...rooms.values()].filter(r => !r.finished).length < 8;
  const connect = peer => ({ ...peer, connectionId: randomUUID(), playerId: null });
  function makeRoom(seed, matchmade = false) {
    if (!hasCapacity()) return null;
    const id = randomBytes(4).toString('hex');
    const match = createMatch(seed);
    const room = { id, ownerKey: randomUUID(), match, game: match.diagnosticState, clients: new Set(), started: false, createdAt: wallNow(), inputs: [], finished: false, debt: 0, steppedAt: 0, spectators: 0, history: [], matchmade, resumes: new Map() };
    rooms.set(id, room); return room;
  }
  const preferredRole = (room, preference) => room.match.preferredRole(preference);
  function record(room, frame) {
    room.writer.append(frame, room.inputs.splice(0));
  }
  function startRecording(room) {
    room.writer = replays.start({ version: VERSION, id: room.id, seed: room.match.seed, hz: HZ, createdAt: room.createdAt, map: room.match.map() });
    record(room, room.match.snapshot());
  }
  function startMatch(room) {
    room.started = true; room.inputs.push({ type: 'start' });
    startRecording(room); remember(room, room.match.snapshot()); broadcastLobby(room);
    broadcast(room, room.match.snapshot());
  }
  function finish(room) {
    if (room.finalization) return room.finalization;
    room.finished = true;
    room.finalization = (async () => {
      try {
        const meta = await room.writer.finish(room.match.result());
        for (const session of room.clients) send(session, { type: 'saved', replay: meta });
      } catch (error) {
        for (const session of room.clients) send(session, { type: 'error', message: 'Replay could not be saved.' });
        reportError(error);
      }
    })();
    // A retired room can leave the room map while its archive is still being published.
    const completion = room.finalization;
    finalizations.add(completion);
    completion.then(() => finalizations.delete(completion), () => finalizations.delete(completion));
    return completion;
  }
  function receive(session, data) {
    if (closing) return;
    if (data.type === 'match' && !session.room) {
      const preference = ['contestant', 'gladiator'].includes(data.role) ? data.role : 'any';
      let room = [...rooms.values()].find(room => room.matchmade && !room.started && !room.finished && preferredRole(room, preference));
      if (!room) room = makeRoom(randomBytes(4).readUInt32BE() % 2147483646 + 1, true);
      if (!room) return send(session, { type: 'error', message: 'All arena slots are occupied. Try matchmaking again after a match ends.' });
      data = { ...data, type: 'join', room: room.id, role: preferredRole(room, preference) };
    }
    if (data.type === 'join' && !session.room) {
      const room = rooms.get(data.room);
      if (!room || room.finished) return send(session, { type: 'error', message: 'This arena has ended or no longer exists. Start a new match.' });
      const owner = data.ownerKey === room.ownerKey;
      if (data.role === 'spectator') {
        // The directed view is unfogged, so it is a wallhack for anyone also holding a player slot.
        // Keep owner authorization even with a delayed stream; there is no public spectator UX yet.
        if (!owner) return send(session, { type: 'error', message: 'Spectating this arena requires its owner key.' });
        if (room.spectators >= MAX_SPECTATORS) return send(session, { type: 'error', message: 'This arena has no spectator capacity left.' });
        session.room = room; session.owner = owner; room.spectators++; room.clients.add(session);
        // A spectator holds no slot, drives no simulation, and never starts a recording.
        const frame = spectatorFrame(room);
        return send(session, { type: 'welcome', id: null, spectator: true, spectatorDelayTicks: SPECTATOR_DELAY_TICKS, room: room.id, owner, map: room.match.spectatorMap(frame), state: room.match.project(frame, null) });
      }
      const role = room.matchmade ? preferredRole(room, data.role) : data.role === 'gladiator' ? 'gladiator' : 'contestant';
      const kit = Object.hasOwn(KITS, data.kit) ? data.kit : 'warden';
      const resumedId = typeof data.resumeKey === 'string' ? room.resumes.get(data.resumeKey) : null;
      let p = resumedId && room.match.player(resumedId);
      if (p) {
        for (const old of room.clients) if (old.playerId === p.id) { room.clients.delete(old); old.room = null; old.close(1000, 'Session resumed'); }
        p = room.match.resume(resumedId);
      } else p = role && room.match.join(session.connectionId, role, kit, typeof data.name === 'string' ? data.name.trim() || 'Player' : 'Player');
      if (!p) return send(session, { type: 'error', message: `No ${role} places remain in this match.` });
      session.room = room; session.owner = owner; session.playerId = p.id;
      room.clients.add(session);
      for (const [key, id] of room.resumes) if (id === p.id) room.resumes.delete(key);
      const resumeKey = randomUUID(); room.resumes.set(resumeKey, p.id);
      if (room.matchmade && !room.startsAt) room.startsAt = wallNow() + 15000;
      room.inputs.push({ type: resumedId ? 'resume' : 'join', id: p.id, role: p.role, kit: p.kit, name: p.name });
      send(session, { type: 'welcome', id: p.id, resumeKey, room: room.id, owner: session.owner, started: room.started, matchmade: !!room.matchmade, startsAt: room.startsAt || null, map: room.match.liveMap(), state: room.match.project(room.match.snapshot(), p.id) });
      broadcastLobby(room);
      return;
    }
    const room = session.room;
    if (!room || room.finished) return;
    if (data.type === 'start' && session.owner && !room.started) {
      startMatch(room);
      return;
    }
    if (!room.started) return;
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
    const room = session.room;
    if (!room) return;
    room.clients.delete(session);
    if (!session.playerId) { room.spectators = Math.max(0, room.spectators - 1); return; }
    if (!room.finished && room.match.leave(session.playerId)) room.inputs.push({ type: 'leave', id: session.playerId });
    if (!room.finished) broadcastLobby(room);
  }
  function advance(elapsed, now) {
    if (closing) return;
    profiler.start('loop.tick');
    let live = 0, stepped = 0;
    for (const [id, room] of rooms) {
      if (room.matchmade && !room.started && room.startsAt && wallNow() >= room.startsAt && room.clients.size > 0) startMatch(room);
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
      room.debt += elapsed;
      // Pause simulation advancement under disk backpressure rather than dropping replay ticks.
      if (room.writer.blocked) { profiler.count('loop.backpressureSkips'); continue; }
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
        state = room.match.advance(); stepped++;
        profiler.start('loop.record'); record(room, state); profiler.stop('loop.record');
        remember(room, state);
        if (room.match.phase === 'finished') break;
      }
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
      for (const room of rooms.values()) if (room.started && !room.finished) { room.match.end(); record(room, room.match.snapshot()); await finish(room); }
      await Promise.all([...finalizations]);
    })();
    return closing;
  }

  return { rooms, hasCapacity, makeRoom, connect, receive, disconnect, advance, close };
}
