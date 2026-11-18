import { randomBytes, randomUUID } from 'node:crypto';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import * as profiler from '../shared/profiler.ts';
import { createMatch } from './match.js';
import { DEFAULT_LIVE_ZONE_SIZE } from '../map/live.ts';
import { send } from './room-views.js';
import { acceptClientMessage, errorMessage, CLIENT_MESSAGE } from './protocol.js';
import { trackLatency, pingSession, acceptPong, roundTripMs } from './latency.js';
import { createRoom, EMPTY_ROOM_GRACE_MS, MATCHMAKING_COUNTDOWN_MS } from './room.js';
import { createRoomThread } from './room-thread.js';
import { mapHere } from './map-pack.js';

export { EMPTY_ROOM_GRACE_MS, MATCHMAKING_COUNTDOWN_MS };

const decoder = new TextDecoder();
// One decoding per payload however many sessions without byte delivery receive it.
const decoded = new WeakMap();
const asText = bytes => {
  let text = decoded.get(bytes);
  if (text === undefined) decoded.set(bytes, text = decoder.decode(bytes));
  return text;
};

/**
 * The room host: manages connected sessions, inbound validation, latency measurement, tick scheduling
 * across rooms, shutdown finalizations, and plain-data `summaries()`/`metrics()` for the directory
 * (room-directory.js) and HTTP API (http-api.js).
 *
 * Single-room lifecycle (seats, waiting yard, match, resumes, history, encoders) lives in `room.js`. With
 * `threads`, each room runs it on its own worker thread (room-thread.js, #1089), with its own scheduler, tick
 * debt and recording worker, so one room's work never delays another's; this thread keeps sessions, sockets,
 * validation, latency and the directory. Without it every room runs here, on this thread's scheduler: the
 * fake-clock tests and benchmarks use that, and `rooms` then holds the live rooms (a diagnostic escape hatch).
 * A threaded room records into `replays.threadOptions` (a file store's) and the store learns of its
 * publications through `replays.published`; an injected writer cannot cross a thread, nor `matchFactory`,
 * `wallNow` or timers, so those apply only to rooms run here.
 *
 * Sessions provide deliver(serializedPayload, droppable, binary) and close(code, reason); no socket dependency.
 * A text payload is a string, or UTF-8 bytes for a session that says `bytes: true` (a threaded room's payloads
 * arrive as bytes; other sessions are given them decoded). A binary payload (a descriptor-codec `state`
 * message, 24.1) is a Uint8Array with `binary` set, and every session is given it as bytes. Only state frames are droppable (protocol.js
 * `deliverable`); deliver returns false for one it skipped. A threaded room decides that itself against
 * `buffered()`, the session's socket backlog, and its payloads are delivered as not droppable.
 * `content` supplies each new room's content: the shipped default, or a differing set a test injects.
 */
export function createRoomService({ replays, devTools = 'none', wallNow = Date.now, reportError = console.error,
  reportReject = console.warn, strictProtocol = false, threads = false,
  replayFinishTimeoutMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout, content = defaultContent, matchFactory = createMatch, wireKey = null }) {
  if (threads && (matchFactory !== createMatch || !replays?.threadOptions)) {
    throw new TypeError('A room on its own thread records into a file store and builds its own match; run rooms here for an injected writer or match');
  }
  const rooms = new Map();
  const sessions = new Map();
  const roomSessions = new Map();
  const finalizations = new Set();
  let closing;

  const connect = peer => {
    const deliver = peer.bytes ? peer.deliver
      : (payload, droppable, binary) => peer.deliver(binary || typeof payload === 'string' ? payload : asText(payload), droppable);
    const session = trackLatency({ ...peer, deliver, connectionId: randomUUID(), playerId: null, rejectedMessages: 0 });
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

  function closeClient(clientId, code, reason) {
    const target = sessions.get(clientId);
    if (!target) return;
    const targetRoomId = target.roomId;
    target.room = null;
    target.roomId = null;
    if (targetRoomId) roomSessions.get(targetRoomId)?.delete(target);
    target.close(code, reason);
  }

  /** A join the room has answered: the session holds its place, or is free to join elsewhere. */
  function settleJoin(session, room, joined) {
    if (!session || session.roomId !== room.id) return;
    if (!joined.ok) {
      // As it was before it asked: never in a room.
      roomSessions.get(room.id)?.delete(session);
      session.room = undefined;
      session.roomId = undefined;
      return;
    }
    if (joined.replacedClientId) {
      const old = sessions.get(joined.replacedClientId);
      if (old && old !== session) {
        old.room = null;
        old.roomId = null;
        roomSessions.get(room.id)?.delete(old);
      }
    }
    session.owner = joined.owner;
    session.dev = joined.dev;
    session.devTools = joined.devTools;
    session.playerId = joined.playerId;
  }

  // A room thread that died unasked: its sessions are told, as for a failed map, and the room is gone.
  function failRoom(roomId) {
    for (const session of roomSessions.get(roomId) ?? []) send(session, errorMessage('This arena stopped unexpectedly. Start a new match.'));
    retireRoom(roomId, []);
  }

  // The threaded room each pending join was sent to, so its answer settles the right session.
  const pendingJoins = new Map();

  function makeThreadedRoom(id, ownerKey, seed, matchmade, size, map, name) {
    return createRoomThread({
      id, ownerKey, seed, matchmade, size, map, name, content: content(), createdAt: wallNow(), devTools,
      replays: replays.threadOptions, replayFinishTimeoutMs, profile: profiler.profiling(), wireKey,
      hooks: {
        deliver: (clientId, payload, binary) => sessions.get(clientId)?.deliver(payload, false, binary),
        backlog: clientId => sessions.get(clientId)?.buffered?.() ?? 0,
        closeClient,
        joined: (clientId, joined) => {
          const room = pendingJoins.get(clientId);
          pendingJoins.delete(clientId);
          if (room) settleJoin(sessions.get(clientId), room, joined);
        },
        onFinalization: trackFinalization,
        onDispose: retireRoom,
        published: meta => replays.published?.(meta),
        reportError,
        failed: failRoom,
      },
    });
  }

  /**
   * Create and register a room, open for joining at once (#258). `map` is the generated map, a
   * promise of it, either packed (map-pack.js), or absent to generate inline (in the room's own thread
   * when threaded). Returns only a plain room descriptor (`{ id, ownerKey, seed, size, name, ready }`),
   * never the live room object; null once closing.
   */
  function makeRoom(seed, matchmade = false, size = DEFAULT_LIVE_ZONE_SIZE, map, name = null) {
    if (closing) return null;
    // A room's identity is minted here, the one entry for inline and threaded rooms alike (#1187): an
    // eight-hex public id, and the secret that proves ownership of a private room.
    const id = randomBytes(4).toString('hex'), ownerKey = randomUUID();
    if (threads) {
      const room = makeThreadedRoom(id, ownerKey, seed, matchmade, size, map, name);
      rooms.set(room.id, room);
      roomSessions.set(room.id, new Set());
      return room.descriptor;
    }
    const room = createRoom({
      replays,
      devTools,
      wallNow,
      reportError,
      replayFinishTimeoutMs,
      setTimer,
      clearTimer,
      matchFactory,
      wireKey,
      // A room here writes text as strings, so its bytes are always a binary state message.
      deliver: (clientId, payload, droppable) => sessions.get(clientId)?.deliver(payload, droppable, payload instanceof Uint8Array),
      closeClient,
      onFinalization: trackFinalization,
      onDispose: retireRoom,
    });
    const here = typeof map?.then === 'function' ? map.then(mapHere) : mapHere(map);
    const descriptor = room.onCreate({ id, ownerKey, seed, matchmade, size, map: here, name, content: content() });
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
      // Routed to the room from now, so what the session sends next follows its join in order; a refusal
      // frees it again. A threaded room answers later, through `joined`.
      session.room = room;
      session.roomId = room.id;
      roomSessions.get(room.id)?.add(session);
      if (threads) pendingJoins.set(session.connectionId, room);
      const joined = room.onJoin(session.connectionId, data);
      if (joined) settleJoin(session, room, joined);
      return;
    }
    if (!session.roomId) return;
    rooms.get(session.roomId)?.onMessage(session.connectionId, data);
  }

  function disconnect(session) {
    session.closed = true;
    sessions.delete(session.connectionId);
    pendingJoins.delete(session.connectionId);
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

  /** Turn profiling on or off here and in every room's thread. */
  function setProfiling(enabled) {
    const on = profiler.enable(enabled);
    for (const room of rooms.values()) room.setProfiling?.(on);
    return on;
  }

  /**
   * Each threaded room's own profiler series, `[{ id, frames, series }]`, for the profile endpoint and summary
   * (#1115). A room run on this thread has none of its own: its series are in this thread's profiler.
   */
  async function roomProfiles() {
    const threaded = [...rooms.values()].filter(room => typeof room.profile === 'function');
    const answers = await Promise.all(threaded.map(async room => ({ id: room.id, profile: await room.profile() })));
    return answers.filter(answer => answer.profile).map(({ id, profile }) => ({ id, frames: profile.frames, series: profile.series }));
  }

  return {
    rooms, devTools, threads, accepting: () => !closing, summaries, metrics, makeRoom, connect, validate, receive, disconnect, advance, close, setProfiling, roomProfiles,
    /** How a room created now would be labelled: the deploy form's default, never a particular room's. */
    defaultPresentation: () => describeContent(content()),
  };
}
