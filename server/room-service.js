import { randomUUID } from 'node:crypto';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import * as profiler from '../shared/profiler.ts';
import { createMatch } from './match.js';
import { DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { send } from './room-views.js';
import { acceptClientMessage, errorMessage, CLIENT_MESSAGE } from './protocol.js';
import { trackLatency, pingSession, acceptPong, roundTripMs } from './latency.js';
import { createRoom, EMPTY_ROOM_GRACE_MS, MATCHMAKING_COUNTDOWN_MS } from './room.js';

export { EMPTY_ROOM_GRACE_MS, MATCHMAKING_COUNTDOWN_MS };

/**
 * The in-process room host: manages connected sessions, inbound validation, latency measurement,
 * tick scheduling across rooms, shutdown finalizations, and plain-data `summaries()`/`metrics()`
 * for the directory (room-directory.js) and HTTP API (http-api.js).
 *
 * Single-room lifecycle (seats, waiting yard, match, resumes, history, encoders) lives in `room.js`.
 * Sessions provide only deliver(serializedPayload, droppable) and close(code, reason); no socket dependency.
 * Only state frames are droppable (protocol.js `deliverable`); deliver returns false for one it skipped.
 * `content` supplies each new room's content: the shipped default, or a differing set a test injects.
 */
export function createRoomService({ replays, devTools = 'none', wallNow = Date.now, reportError = console.error,
  reportReject = console.warn, strictProtocol = false,
  replayFinishTimeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout, content = defaultContent, matchFactory = createMatch }) {
  const rooms = new Map();
  const sessions = new Map();
  const roomSessions = new Map();
  const finalizations = new Set();
  let closing;

  const connect = peer => {
    const session = trackLatency({ ...peer, connectionId: randomUUID(), playerId: null, rejectedMessages: 0 });
    sessions.set(session.connectionId, session);
    return session;
  };
  const validate = (session, raw) => acceptClientMessage(session, raw, { strict: strictProtocol, log: reportReject, now: wallNow() });

  function trackFinalization(completion) {
    finalizations.add(completion);
    completion.then(() => finalizations.delete(completion), () => finalizations.delete(completion));
  }

  function retireRoom(roomId, clientIds) {
    rooms.delete(roomId);
    const attached = roomSessions.get(roomId);
    roomSessions.delete(roomId);
    for (const clientId of clientIds) {
      const session = sessions.get(clientId);
      if (session && session.roomId === roomId) {
        session.room = null;
        session.roomId = null;
        session.playerId = null;
      }
    }
    if (attached) {
      for (const session of attached) {
        if (session.roomId === roomId) {
          session.room = null;
          session.roomId = null;
          session.playerId = null;
        }
      }
    }
  }

  /**
   * Create and register a room, open for joining at once (#258). `map` is the generated map, a
   * promise of it, or absent to generate inline. Returns only a plain room descriptor
   * (`{ id, ownerKey, seed, size, name, ready }`), never the live room object; null once closing.
   */
  function makeRoom(seed, matchmade = false, size = DEFAULT_LIVE_ZONE_SIZE, map, name = null) {
    if (closing) return null;
    const room = createRoom({
      replays,
      devTools,
      wallNow,
      reportError,
      replayFinishTimeoutMs,
      setTimer,
      clearTimer,
      matchFactory,
      deliver: (clientId, payload, droppable) => sessions.get(clientId)?.deliver(payload, droppable),
      closeClient: (clientId, code, reason) => {
        const target = sessions.get(clientId);
        if (!target) return;
        const targetRoomId = target.roomId;
        target.room = null;
        target.roomId = null;
        if (targetRoomId) roomSessions.get(targetRoomId)?.delete(target);
        target.close(code, reason);
      },
      onFinalization: trackFinalization,
      onDispose: retireRoom,
    });
    const descriptor = room.onCreate({ seed, matchmade, size, map, name, content: content() });
    rooms.set(descriptor.id, room);
    roomSessions.set(descriptor.id, new Set());
    return descriptor;
  }

  /** Every unfinished room's public summary: plain data, never the room, and never its owner key. */
  const summaries = () => [...rooms.values()].map(room => room.summary()).filter(Boolean);

  function receive(session, raw) {
    if (closing) return;
    const validated = validate(session, raw);
    if (!validated.ok) {
      if (validated.type === CLIENT_MESSAGE.JOIN && !session.roomId) {
        send(session, errorMessage(validated.reason));
      } else if (session.roomId) {
        rooms.get(session.roomId)?.onInvalidMessage(session.connectionId, {
          type: validated.type,
          reason: validated.reason,
          action: raw?.action,
          id: typeof raw?.id === 'string' && raw.id ? raw.id : null,
        });
      }
      return;
    }
    const data = validated.message;
    if (data.type === CLIENT_MESSAGE.PONG) {
      // A fresh measurement is the only thing that changes how far a shot is rewound, so it is
      // applied here rather than re-derived every tick.
      if (acceptPong(session, data, wallNow()) && session.roomId) {
        rooms.get(session.roomId)?.setViewLag(session.connectionId, roundTripMs(session));
      }
      return;
    }
    if (data.type === CLIENT_MESSAGE.JOIN && !session.roomId) {
      const room = rooms.get(data.room);
      if (!room || room.finished) return send(session, errorMessage('This arena has ended or no longer exists. Start a new match.'));
      const joined = room.onJoin(session.connectionId, data);
      if (!joined.ok) return;
      if (joined.replacedClientId) {
        const old = sessions.get(joined.replacedClientId);
        if (old) {
          old.room = null;
          old.roomId = null;
          roomSessions.get(room.id)?.delete(old);
        }
      }
      session.room = room;
      session.roomId = room.id;
      session.owner = joined.owner;
      session.dev = joined.dev;
      session.devTools = joined.devTools;
      session.playerId = joined.playerId;
      roomSessions.get(room.id)?.add(session);
      return;
    }
    if (!session.roomId) return;
    rooms.get(session.roomId)?.onMessage(session.connectionId, data);
  }

  function disconnect(session) {
    session.closed = true;
    sessions.delete(session.connectionId);
    const roomId = session.roomId;
    if (!roomId) return;
    session.roomId = null;
    roomSessions.get(roomId)?.delete(session);
    rooms.get(roomId)?.onLeave(session.connectionId, true);
  }

  function advance(elapsed, now) {
    if (closing) return;
    profiler.start('loop.tick');
    let live = 0, stepped = 0;
    for (const [id, room] of [...rooms]) {
      const attached = roomSessions.get(id);
      if (attached) for (const session of attached) pingSession(session, wallNow(), send);
      const result = room.tick(elapsed, now);
      if (result.retired) continue;
      if (result.live) live++;
      stepped += result.stepped;
    }
    profiler.stop('loop.tick');
    profiler.count('loop.liveRooms', live);
    profiler.count('loop.simSteps', stepped);
    profiler.frame();
  }

  function close() {
    if (!closing) closing = (async () => {
      const pending = [...rooms.values()].map(room => room.close());
      await Promise.all(pending);
      await Promise.all([...finalizations]);
    })();
    return closing;
  }

  /** Counts of live rooms (started, unfinished) for the health and profile endpoints; plain numbers, never a room. */
  const metrics = () => {
    let live = 0, emptyLive = 0;
    for (const room of rooms.values()) {
      const m = room.metrics();
      if (m.live) { live++; if (m.emptyLive) emptyLive++; }
    }
    return { liveRooms: live, emptyLiveRooms: emptyLive };
  };

  return {
    rooms, devTools, accepting: () => !closing, summaries, metrics, makeRoom, connect, validate, receive, disconnect, advance, close,
    /** How a room created now would be labelled: the deploy form's default, never a particular room's. */
    defaultPresentation: () => describeContent(content()),
  };
}
