import { randomUUID } from 'node:crypto';
import { DEFAULT_KIT, HZ, ROLES } from '../shared/simulation/rules.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { describeContent } from '../shared/presentation.ts';
import { SCHEMA, minimumReaderForMatch } from '../shared/recording.ts';
import * as profiler from '../shared/profiler.ts';
import { createMatch, createLobby } from './match.js';
import { randomWireIdKey } from './wire-key.js';
import { DEFAULT_LIVE_ZONE_SIZE, zoneSizeName } from '../map/live.ts';
import { TICK_MS, MAX_CATCHUP } from './scheduler.js';
import { send, broadcast, broadcastLobby, broadcastWaiting, spectatorFrame, remember, rosterRevision, viewEncoders, SPECTATOR_DELAY_TICKS } from './room-views.js';
import { createWaiting, enterWaiting, changeWaiting, leaveWaiting, waitingInput, stepWaiting, waitingView, waitingSeats, waitingConstants } from '../shared/simulation/waiting.ts';
import { waitingYard } from '../shared/waiting-yard.ts';
import { JSON_STATE_REFUSED } from '../shared/protocol.ts';
import {
  normalizeDiagnostic,
  playerWelcomeMessage,
  spectatorWelcomeMessage,
  devWelcomeMessage,
  readyMessage,
  chooseReplyMessage,
  teleportReplyMessage,
  pausedMessage,
  savedMessage,
  replayStatusMessage,
  errorMessage,
  CLIENT_MESSAGE,
  CLOSE_CODE,
  CLOSE_REASON,
  DEFAULT_PLAYER_NAME,
  MAX_DIAGNOSTICS_PER_SESSION,
  MIN_DIAGNOSTIC_INTERVAL_MS,
} from './protocol.js';

export const EMPTY_ROOM_GRACE_MS = 30000;
/** How long a matchmade room counts down from its first join to the start. */
export const MATCHMAKING_COUNTDOWN_MS = 15000;
/** How long an unstarted (or finished) room with nobody in it is kept. */
const UNSTARTED_ROOM_IDLE_MS = 180000;
// How long a prepared match waits for its recording to take in the header before the room adopts it
// anyway (#1088): a stalled sink must not hold the room back, it only risks the start's frames again.
const RECORDING_OPEN_TIMEOUT_MS = 5000;
const MAX_SPECTATORS = 24;

const byRole = count => Object.fromEntries(ROLES.map(role => [role, count(role)]));

/**
 * Single-room lifecycle shaped around Colyseus-style hooks (`onCreate`, `onJoin`, `onLeave`,
 * `onMessage`, `onDispose`), keeping inbound commands/inputs as plain data and outbound wire
 * traffic as serialized payloads via `deliver(clientId, serializedPayload, droppable)`, and a player session's
 * fast state via `datagram(clientId, bytes)` when its transport has datagrams (room-views.js `deliversFast`).
 *
 * Explicit internal boundaries:
 * - Waiting-yard simulation to match handoff (`waiting` -> `match`) in `startMatch()`
 * - Reconnect / takeover and rotating `resumeKey` handling (`resumes`) in `onJoin()`
 * - Historical spectator projection and keyframe delivery in `view()` and `room-views.js`
 */
export function createRoom({
  replays,
  devTools = 'none',
  wallNow = Date.now,
  reportError = console.error,
  replayFinishTimeoutMs = 5000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  matchFactory = createMatch,
  // How this room keys its match's and waiting yard's outward IDs (#1164): 'random' draws a fresh key for
  // each (createArenaServer's default), a literal key is used as given (tests), and null keeps internal IDs.
  wireKey = null,
  deliver = () => true,
  datagram = () => true,
  closeClient = () => {},
  onFinalization = () => {},
  onDispose: notifyDispose = () => {},
} = {}) {
  let state = null;
  // Drawn here, per match and per yard, so a room on its own thread draws its own.
  const drawWireKey = () => wireKey === 'random' ? randomWireIdKey() : wireKey;
  const clientMap = new Map();
  let resolveDeferredMap, rejectDeferredMap;

  const isCurrent = () => Boolean(state && !state.finished && !state.disposed && !state.closing);
  const devAllowed = owner => devTools === 'all' || devTools === 'owner' && owner;
  // Every welcome and ready names the room's content and its display descriptor, map or no map (22.7).
  const described = () => ({ contentId: state.presentation.contentId, presentation: state.presentation });
  const deliverTo = (clientId, value) => send({ deliver: (payload, droppable) => deliver(clientId, payload, droppable) }, value);

  function makeClientRecord(clientId, fields = {}) {
    return {
      connectionId: clientId,
      playerId: null,
      owner: false,
      dev: false,
      devTools: false,
      // How this connection's state messages are written (24.1): its join's negotiated encoding.
      stateEncoding: 'binary',
      diagnosticCount: 0,
      diagnosticAt: -Infinity,
      layerKeys: {},
      // Whether the session's transport has datagrams (onJoin's `transport`); the newest acknowledged fast frame's
      // tick, the fast frames sent and the slow version held, for the split delivery (room-views.js).
      datagrams: false,
      fastAck: null,
      fastHistory: null,
      slowVersion: null,
      deliver: (payload, droppable) => deliver(clientId, payload, droppable),
      datagram: payload => datagram(clientId, payload),
      close: (code, reason) => closeClient(clientId, code, reason),
      ...fields,
    };
  }

  /**
   * Initialize the room from plain creation options. `map` may be a generated map, a promise of
   * one (#258), omitted for inline generation, or deferred via `deferredMap: true` + `adoptMap`/`failMap`.
   * Returns only a plain room descriptor, never the mutable room instance.
   */
  function onCreate({
    id,
    ownerKey,
    seed = 0,
    matchmade = false,
    size = DEFAULT_LIVE_ZONE_SIZE,
    map = undefined,
    deferredMap = false,
    name = null,
    content = defaultContent(),
    createdAt = wallNow(),
  } = {}) {
    // The host mints a room's identity (room-service.js, #1187); a room never invents its own.
    if (typeof id !== 'string' || !id || typeof ownerKey !== 'string' || !ownerKey) throw new Error('a room is created with its id and owner key');
    if (state) throw new Error('Room already created');
    const lobby = createLobby(content);
    state = {
      id,
      ownerKey,
      seed,
      size,
      content: lobby.content,
      presentation: lobby.presentation,
      // `seats` answers who holds which place: the lobby's until the match exists, then the match's own.
      seats: lobby,
      match: null,
      game: null,
      clients: new Set(),
      started: false,
      createdAt,
      inputs: [],
      finished: false,
      debt: 0,
      steppedAt: 0,
      spectators: 0,
      history: [],
      matchmade,
      name,
      resumes: new Map(),
      ...viewEncoders(),
      // Where players walk until the start (#236): its own simulation, never recorded, gone once the match starts.
      waiting: createWaiting(waitingYard(), { wireKey: drawWireKey() }),
      waitingDebt: 0,
      startRequested: false,
      startsAt: undefined,
      pausedAt: undefined,
      emptySince: undefined,
      writer: undefined,
      recordingStatus: undefined,
      recordingError: undefined,
      finalization: undefined,
      ready: undefined,
      initializing: undefined,
      disposed: false,
      closing: false,
    };
    if (deferredMap) {
      const pending = new Promise((resolve, reject) => {
        resolveDeferredMap = resolve;
        rejectDeferredMap = reject;
      });
      state.ready = pending.then(resolved => openMatch(resolved), error => abandonGeneration(error));
    } else if (typeof map?.then === 'function') {
      // Settles once the room has its match or has been given up, and never rejects, so it can be awaited.
      state.ready = map.then(resolved => openMatch(resolved), error => abandonGeneration(error));
    } else {
      state.ready = Promise.resolve(openMatch(map));
    }
    return { id: state.id, ownerKey: state.ownerKey, seed: state.seed, size: state.size, name: state.name, ready: state.ready };
  }

  function adoptMap(map) {
    if (resolveDeferredMap) {
      const resolve = resolveDeferredMap;
      resolveDeferredMap = null;
      rejectDeferredMap = null;
      resolve(map);
      return state.ready;
    }
    return openMatch(map);
  }

  function failMap(error) {
    if (rejectDeferredMap) {
      const reject = rejectDeferredMap;
      resolveDeferredMap = null;
      rejectDeferredMap = null;
      reject(error);
      return state.ready;
    }
    return abandonGeneration(error);
  }

  function openMatch(map) {
    if (!state || state.match || !isCurrent()) return;
    const match = matchFactory(state.seed, state.size, map, state.content, { wireKey: drawWireKey() });
    if (typeof match?.then === 'function') {
      return state.initializing = match.then(ready => recordingOpened(ready)).then(ready => adoptMatch(ready), error => abandonGeneration(error));
    }
    if (isCurrent()) openRecording(match);
    adoptMatch(match);
  }

  /**
   * Opens the recording as soon as the match is prepared, and waits for the writer to take in the header,
   * which carries the whole map (#1088). Compressing a large map's header took longer than the four frames
   * the writer's budget holds beside it, so a room that opened it at the start dropped its own first frames.
   * The header's bytes are the same either way (26); nothing is recorded before the start.
   */
  async function recordingOpened(match) {
    if (!isCurrent()) return match;
    openRecording(match);
    const opened = state.writer?.opened;
    if (!opened) return match;
    let timer;
    await Promise.race([opened, new Promise(resolve => { timer = setTimer(resolve, RECORDING_OPEN_TIMEOUT_MS); })]);
    clearTimer(timer);
    return match;
  }

  function adoptMatch(match) {
    if (!isCurrent()) { match.dispose(); discardRecording(); return; }
    // Nothing is recorded before the start, so every command so far is a seat the lobby gave out.
    match.seat(state.inputs);
    // `game` stays the tests' and benchmarks' escape hatch; nothing here reads it.
    Object.assign(state, { match, seats: match, game: match.diagnosticState });
    // Players stay in the waiting area, so only those watching are shown the new map now.
    for (const client of state.clients) if (!client.playerId) sendEnvelope(client, readyMessage({ ...described(), ...view(client) }));
    broadcastLobby(state);
    if (state.startRequested) startMatch();
  }

  function abandonGeneration(error) {
    // Closing stops the generator, which fails what it held; that is not a fault to report.
    if (!state || state.closing) return;
    reportError(error);
    if (!isCurrent()) return;
    state.finished = true;
    for (const client of state.clients) send(client, errorMessage('The arena could not be generated. Try again.'));
    onDispose();
  }

  /**
   * What a client is shown of the room's map and state. A player sees the waiting area until the start,
   * which keeps the match map hidden (17.3 #15); anyone else sees nothing until the map exists.
   */
  function view(client) {
    const shown = viewOf(client);
    return { ...shown, rosterRevision: rosterRevision(state, shown.roster) };
  }
  function viewOf(client) {
    // `constants` come with the map they belong to: the yard's, then the match's in the start's `ready` (24.3).
    if (client.playerId && state.waiting) return { map: state.waiting.map, state: waitingView(state.waiting, client.playerId), roster: waitingSeats(state.waiting), constants: waitingConstants() };
    if (!state.match) return { map: null, state: null, roster: state.seats.seatMetadata(), constants: null };
    const constants = state.match.constants();
    if (client.playerId) { const frame = state.match.snapshot(); return { map: state.match.payloadMap('live'), state: state.match.project(frame, client.playerId), roster: state.match.seatMetadata(frame), constants }; }
    // A spectator is shown the delayed frame; the dev view the present one.
    const frame = client.dev ? state.match.snapshot() : spectatorFrame(state);
    return { map: state.match.payloadMap('spectator', frame), state: state.match.project(frame, null), roster: state.match.seatMetadata(frame), constants };
  }

  function replayStatus(status) {
    if (state.recordingStatus?.status === status || state.recordingStatus?.status === 'failed') return;
    state.recordingStatus = replayStatusMessage(status, status === 'failed'
      ? 'Replay recording is unavailable. Gameplay continues.'
      : 'Replay recording has missing frames. Gameplay continues.');
    for (const client of state.clients) send(client, state.recordingStatus);
  }

  function failRecording(error) {
    if (state.recordingError) return;
    state.recordingError = error instanceof Error ? error : new Error(String(error));
    try { state.writer?.abort?.(state.recordingError); } catch { /* Recording cleanup cannot stop the match. */ }
    replayStatus('failed');
    reportError(state.recordingError);
  }

  function record(frame) {
    const commands = state.inputs.splice(0);
    if (state.recordingError) return;
    try {
      if (state.writer.failed) return failRecording(state.writer.failed);
      const accepted = state.writer.append(frame, commands);
      if (state.writer.failed) failRecording(state.writer.failed);
      else if (accepted === false || state.writer.droppedFrames > 0) replayStatus('partial');
    } catch (error) { failRecording(error); }
  }

  // Diagnostics are metadata beside the recording, never a command, and never able to fail it.
  function markDiagnostic(marker) {
    try { if (!state.recordingError) state.writer?.mark?.(marker); } catch { /* Markers cannot stop the match. */ }
  }

  // A dev pause stops the room's clock: no tick runs, so tick order and RNG are untouched, and owed time
  // is dropped rather than caught up. The recording learns of it as one mark, with how long it lasted.
  function setPaused(paused) {
    if ((state.pausedAt != null) === paused) return;
    if (paused) state.pausedAt = wallNow();
    else settlePause();
    state.debt = 0; state.steppedAt = 0;
    const message = pausedMessage(paused);
    for (const client of state.clients) send(client, message);
  }

  function settlePause() {
    if (state.pausedAt == null) return;
    markDiagnostic({ tick: state.match.tick, kind: 'pause', pausedMs: wallNow() - state.pausedAt });
    state.pausedAt = null;
  }

  // The recording's header, before any frame. A writer that has been discarded reports nothing.
  function openRecording(match) {
    if (state.writer || state.recordingError) return;
    try {
      const map = match.payloadMap('recording');
      let writer;
      writer = state.writer = replays.start({
        version: match.version, schema: SCHEMA, minSchema: minimumReaderForMatch(),
        contentId: match.contentId, presentation: state.presentation, id: state.id,
        seed: match.seed, hz: HZ, createdAt: state.createdAt, map,
      }, { onError: error => { if (!writer || state.writer === writer) failRecording(error); } });
      if (state.recordingError) state.writer?.abort?.(state.recordingError);
    } catch (error) { failRecording(error); }
  }

  // A room that ends before its start gives up the recording it opened: no frame, no file, no error.
  function discardRecording() {
    const writer = state.writer;
    if (!writer || state.started) return;
    state.writer = undefined;
    try { writer.discard ? writer.discard() : writer.abort?.(new Error('Replay recording was discarded')); }
    catch { /* Recording cleanup cannot stop the room. */ }
  }

  function startRecording() {
    openRecording(state.match);
    record(state.match.snapshot());
  }

  /** Explicit `waiting` -> `match` handoff once the match map exists and play begins. */
  function startMatch() {
    state.started = true;
    state.inputs.push({ type: 'start' });
    state.waiting?.dispose();
    state.waiting = null;
    state.waitingDebt = 0;
    startRecording();
    remember(state, state.match.snapshot());
    // Out of the waiting area and onto the match map, each from their own spawn.
    for (const client of state.clients) if (client.playerId) sendEnvelope(client, readyMessage({ ...described(), ...view(client) }));
    broadcastLobby(state);
    broadcast(state, state.match.snapshot());
  }

  function finish() {
    if (state.finalization) return state.finalization;
    state.finished = true;
    settlePause();
    state.waiting?.dispose();
    state.waiting = null;
    state.match?.dispose();
    state.finalization = (async () => {
      let deadline;
      try {
        if (!state.writer) return;
        const meta = await Promise.race([
          Promise.resolve().then(() => state.writer.finish(state.match.result())),
          new Promise((_resolve, reject) => { deadline = setTimer(() => reject(new Error('Replay finalization timed out')), replayFinishTimeoutMs); }),
        ]);
        if (state.recordingError) return;
        for (const client of state.clients) send(client, savedMessage(meta));
      } catch (error) {
        failRecording(error);
      } finally { if (deadline !== undefined) clearTimer(deadline); }
    })();
    onFinalization(state.finalization);
    return state.finalization;
  }

  // A joined client's welcome, then the recording's status when one is showing.
  // A welcome or ready delivers a roster under its revision, so the client holds one from the first frame and
  // no `seats` repeats it (#1131).
  function sendEnvelope(client, message) {
    if (send(client, message) !== false) client.rosterRevision = message.rosterRevision;
  }
  function sendWelcome(client, message) {
    sendEnvelope(client, message);
    if (state.recordingStatus) send(client, state.recordingStatus);
  }

  function refuseJoin(clientId, reason) {
    deliverTo(clientId, errorMessage(reason));
    return { ok: false, reason };
  }

  // A client that holds no slot counts against spectator capacity; `fields` say what it may see.
  function admitWatcher(clientId, fields, buildMessage) {
    if (state.spectators >= MAX_SPECTATORS) return refuseJoin(clientId, 'This arena has no spectator capacity left.');
    const client = makeClientRecord(clientId, fields);
    state.spectators++;
    state.clients.add(client);
    clientMap.set(clientId, client);
    sendWelcome(client, buildMessage(client));
    return { ok: true, clientId, playerId: null, owner: client.owner, dev: !!client.dev, devTools: client.devTools, replacedClientId: null };
  }

  function joinDev(clientId, owner, stateEncoding) {
    if (!devAllowed(owner)) {
      return refuseJoin(clientId, devTools === 'owner' ? 'The dev view of this arena requires its owner key.' : 'The dev view is not enabled on this server.');
    }
    // A spectator without the delay: no slot, no input authority, no recording of its own.
    return admitWatcher(clientId, { owner, dev: true, devTools: true, stateEncoding }, client => devWelcomeMessage({
      room: state.id, owner, started: state.started, ready: !!state.match, paused: state.pausedAt != null, stateEncoding, ...described(), ...view(client),
    }));
  }

  function joinSpectator(clientId, owner, stateEncoding) {
    // The directed view is unfogged, so it is a wallhack for anyone also holding a player slot.
    // Keep owner authorization even with a delayed stream; there is no public spectator UX yet.
    if (!owner) return refuseJoin(clientId, 'Spectating this arena requires its owner key.');
    // A spectator holds no slot, drives no simulation, and never starts a recording.
    return admitWatcher(clientId, { owner, devTools: devAllowed(owner), stateEncoding }, client => spectatorWelcomeMessage({
      spectatorDelayTicks: SPECTATOR_DELAY_TICKS, room: state.id, owner, devTools: client.devTools, stateEncoding,
      ready: !!state.match, paused: state.pausedAt != null, ...described(), ...view(client),
    }));
  }

  function joinPlayer(clientId, owner, options, transport) {
    const asked = options.role === 'gladiator' ? 'gladiator' : 'contestant';
    // Before the start a full side falls back to the other, since the lobby lets a player change (#235).
    const role = state.matchmade ? state.seats.preferredRole(options.role) : state.started ? asked : state.seats.preferredRole(asked);
    // Validated against the content this match was pinned to, not whatever the process ships.
    const kit = state.seats.hasKit(options.kit) ? options.kit : DEFAULT_KIT;
    const resumedId = options.resumeKey ? state.resumes.get(options.resumeKey) : null;
    let p = resumedId && state.seats.player(resumedId);
    let replacedClientId = null;
    if (p) {
      for (const old of state.clients) {
        if (old.playerId === p.id) {
          replacedClientId = old.connectionId;
          state.clients.delete(old);
          clientMap.delete(old.connectionId);
          old.close(CLOSE_CODE.NORMAL, CLOSE_REASON.SESSION_RESUMED);
        }
      }
      p = state.seats.resume(resumedId);
    } else {
      p = role && state.seats.join(clientId, role, kit, options.name ?? DEFAULT_PLAYER_NAME);
    }
    if (!p) return refuseJoin(clientId, `No ${role} places remain in this match.`);
    const stateEncoding = options.stateEncoding;
    const client = makeClientRecord(clientId, { playerId: p.id, owner, dev: false, devTools: devAllowed(owner), stateEncoding, datagrams: !!transport.datagrams });
    state.clients.add(client);
    clientMap.set(clientId, client);
    for (const [key, id] of state.resumes) if (id === p.id) state.resumes.delete(key);
    const resumeKey = randomUUID();
    state.resumes.set(resumeKey, p.id);
    if (state.matchmade && !state.startsAt) state.startsAt = wallNow() + MATCHMAKING_COUNTDOWN_MS;
    state.inputs.push({ type: resumedId ? 'resume' : 'join', id: p.id, role: p.role, kit: p.kit, name: p.name });
    if (state.waiting) enterWaiting(state.waiting, p.id, p.role, p.kit, p.name);
    sendWelcome(client, playerWelcomeMessage({
      id: p.id, resumeKey, room: state.id, owner: client.owner, devTools: client.devTools, stateEncoding,
      paused: state.pausedAt != null, started: state.started, ready: !!state.match,
      matchmade: !!state.matchmade, startsAt: state.startsAt || null, ...described(), ...view(client),
    }));
    broadcastLobby(state);
    return { ok: true, clientId, playerId: p.id, owner: client.owner, dev: false, devTools: client.devTools, replacedClientId };
  }

  /**
   * Admit a client into this room as a player, spectator, or dev watcher. `transport` is the host's, never the
   * client's: `{ datagrams }` when the session can be sent datagrams.
   */
  function onJoin(clientId, options = {}, transport = {}) {
    if (!isCurrent() || clientMap.has(clientId)) {
      return refuseJoin(clientId, 'This arena has ended or no longer exists. Start a new match.');
    }
    const owner = options.ownerKey === state.ownerKey;
    // JSON state is a debug encoding (24.1): granted with dev tools, and refused outright otherwise, so a
    // page never reads an encoding it did not ask for.
    const stateEncoding = options.stateEncoding ?? 'binary';
    if (stateEncoding === 'json' && !devAllowed(owner)) {
      return refuseJoin(clientId, JSON_STATE_REFUSED);
    }
    if (options.mode === 'dev') return joinDev(clientId, owner, stateEncoding);
    if (options.mode === 'spectator') return joinSpectator(clientId, owner, stateEncoding);
    return joinPlayer(clientId, owner, { ...options, stateEncoding }, transport);
  }

  /** Remove a client from this room, freeing its spectator slot or returning its seat to a bot. */
  function onLeave(clientId, _consented = true) {
    const client = clientMap.get(clientId);
    if (!client) return false;
    clientMap.delete(clientId);
    state.clients.delete(client);
    if (!client.playerId) {
      state.spectators = Math.max(0, state.spectators - 1);
      return true;
    }
    if (!state.finished && state.seats.leave(client.playerId)) state.inputs.push({ type: 'leave', id: client.playerId });
    if (state.waiting) leaveWaiting(state.waiting, client.playerId);
    if (!state.finished) broadcastLobby(state);
    return true;
  }

  /** Handle a validated inbound client message belonging to this room. */
  function onMessage(clientId, data) {
    if (!isCurrent()) return;
    const client = clientMap.get(clientId);
    if (!client) return;
    if (data.type === CLIENT_MESSAGE.START && client.owner && !state.started) {
      // An early start waits for the map rather than being refused.
      if (state.match) startMatch();
      else { state.startRequested = true; broadcastLobby(state); }
      return;
    }
    if (data.type === CLIENT_MESSAGE.CHOOSE && client.playerId && !state.started) {
      const p = state.seats.choose(client.playerId, data.role, data.kit);
      if (!p) return send(client, chooseReplyMessage(`No ${data.role} places remain in this match.`));
      // Recorded like a join, so a match built after it replays the same seats (`seat`).
      state.inputs.push({ type: 'choose', id: p.id, role: p.role, kit: p.kit });
      // Shown in the waiting area from the next frame; the match place itself stays hidden until the start.
      changeWaiting(state.waiting, p.id, p.role, p.kit);
      broadcastLobby(state);
      return;
    }
    // Walking about before the start: the waiting area's own, never a match command, never recorded.
    if (data.type === CLIENT_MESSAGE.INPUT && client.playerId && state.waiting) {
      waitingInput(state.waiting, client.playerId, data);
      return;
    }
    if (!state.started) return;
    // Dev controls: any client the server's dev tools policy admits, never a later-joining one it does not.
    if (data.type === CLIENT_MESSAGE.DEV && client.devTools) {
      if (data.action === 'pause' || data.action === 'resume') setPaused(data.action === 'pause');
      if (data.action === 'teleport') {
        const moved = state.match.teleport(data.id, data.x, data.y);
        send(client, moved ? teleportReplyMessage(true, moved.id) : teleportReplyMessage(false, data.id));
        if (!moved) return;
        // Recorded with the next tick's frame, like any command between ticks.
        state.inputs.push(moved);
        // A paused room sends no frames, so show the move now rather than on resume.
        if (state.pausedAt != null) {
          const snapshot = state.match.snapshot();
          remember(state, snapshot);
          broadcast(state, snapshot);
        }
      }
      return;
    }
    if (data.type === CLIENT_MESSAGE.DIAGNOSTIC && client.playerId) {
      // Metadata about the client's experience: never an input, never read by the simulation.
      const now = wallNow(), count = client.diagnosticCount || 0;
      if (count >= MAX_DIAGNOSTICS_PER_SESSION || now - (client.diagnosticAt ?? -Infinity) < MIN_DIAGNOSTIC_INTERVAL_MS) return;
      const marker = normalizeDiagnostic(data, state.match.tick, client.playerId);
      if (!marker) return;
      client.diagnosticCount = count + 1;
      client.diagnosticAt = now;
      markDiagnostic(marker);
      return;
    }
    if (data.type === CLIENT_MESSAGE.INPUT && client.playerId) {
      const accepted = state.match.acceptInput(client.playerId, data);
      if (accepted) state.inputs.push(accepted);
      return;
    }
    if (data.type === CLIENT_MESSAGE.FINISH && client.owner) {
      state.match.end({ strand: true });
      const snapshot = state.match.snapshot();
      record(snapshot);
      remember(state, snapshot);
      broadcast(state, snapshot);
      void finish();
    }
  }

  /** Send room-contextual refusal replies when schema validation rejects a message. */
  function onInvalidMessage(clientId, { type, reason, action, id }) {
    if (!isCurrent()) return;
    const client = clientMap.get(clientId);
    if (!client) return;
    if (type === CLIENT_MESSAGE.CHOOSE && client.playerId && !state.started) {
      send(client, chooseReplyMessage(reason));
    } else if (type === CLIENT_MESSAGE.DEV && action === 'teleport' && state.started && client.devTools) {
      send(client, teleportReplyMessage(false, typeof id === 'string' && id ? id : null));
    }
  }

  /** Apply an updated server-measured round-trip latency for a seated client. */
  function setViewLag(clientId, rttMs) {
    if (!isCurrent() || !state.match) return false;
    const client = clientMap.get(clientId);
    if (!client?.playerId) return false;
    return state.match.setViewLag(client.playerId, rttMs);
  }

  /**
   * A session's acknowledgement of the newest fast frame it holds (24.2 "Acknowledgement and baselines"): its
   * next frames are deltas against that one while the history holds it. A late, older one changes nothing, and
   * neither does a tick past the match's, which no frame could have carried: kept, it would outrank every true
   * acknowledgement after it.
   */
  function onAck(clientId, tick) {
    const client = clientMap.get(clientId);
    if (!client || !state.match || tick > state.match.tick) return;
    if (client.fastAck === null || tick > client.fastAck) client.fastAck = tick;
  }

  // The waiting area keeps the match's tick rate on its own clock, so walking there feels the same.
  function advanceWaiting(elapsed) {
    if (!state.waiting.players.length) { state.waitingDebt = 0; return; }
    state.waitingDebt += elapsed;
    const owed = Math.floor(state.waitingDebt / TICK_MS);
    if (!owed) return;
    state.waitingDebt -= owed * TICK_MS;
    for (let i = 0; i < Math.min(owed, MAX_CATCHUP); i++) stepWaiting(state.waiting);
    broadcastWaiting(state, waitingView);
  }

  /** Advance one room's countdowns, idle retirement, waiting yard, or live simulation. */
  function tick(elapsed, now) {
    if (!state || state.disposed || state.closing) return { retired: false, live: false, stepped: 0 };
    // The countdown runs while the map generates, but the match waits for it.
    if (state.matchmade && !state.started && state.match && state.startsAt && wallNow() >= state.startsAt && state.clients.size > 0) {
      startMatch();
    }
    if ((!state.started || state.finished) && state.clients.size === 0 && wallNow() - state.createdAt > UNSTARTED_ROOM_IDLE_MS) {
      onDispose();
      return { retired: true, live: false, stepped: 0 };
    }
    if (state.waiting && !state.finished) {
      advanceWaiting(elapsed);
      return { retired: false, live: false, stepped: 0 };
    }
    if (!state.started || state.finished) return { retired: false, live: false, stepped: 0 };
    // Keep a short reconnect window, but abandoned playtests must not run ten minutes of bots
    // and gzip recording in the background while the owner is testing another arena.
    if (state.clients.size === 0) {
      state.emptySince ??= wallNow();
      if (wallNow() - state.emptySince >= EMPTY_ROOM_GRACE_MS) {
        state.match.end({ strand: true });
        state.inputs.push({ type: 'abandoned', reason: 'No viewers after reconnect grace' });
        record(state.match.snapshot());
        void finish();
        return { retired: false, live: false, stepped: 0 };
      }
    } else {
      state.emptySince = null;
    }
    if (state.pausedAt != null) return { retired: false, live: true, stepped: 0 };
    state.debt += elapsed;
    const owed = Math.floor(state.debt / TICK_MS);
    if (!owed) return { retired: false, live: true, stepped: 0 };
    state.debt -= owed * TICK_MS;
    if (owed > MAX_CATCHUP) profiler.count('loop.droppedTicks', owed - MAX_CATCHUP);
    const ticks = Math.min(owed, MAX_CATCHUP);
    if (state.steppedAt) profiler.observe('sim.tickPacing', (now - state.steppedAt) / ticks);
    state.steppedAt = now;
    // Offer every tick to the bounded recorder; storage pressure never delays gameplay.
    // Only the newest state reaches clients after a catch-up batch.
    let frame, simulated = 0;
    for (let i = 0; i < ticks; i++) {
      frame = state.match.advance();
      simulated++;
      profiler.start('loop.record'); record(frame); profiler.stop('loop.record');
      remember(state, frame);
      if (state.match.phase === 'finished') break;
    }
    // The sim fell behind wall time; tick numbers stay continuous, so only this marker shows it.
    if (owed > MAX_CATCHUP && frame) {
      markDiagnostic({ tick: frame.tick, kind: 'server-stall', wakeMs: Math.round(elapsed), owed, simulated });
    }
    profiler.start('loop.broadcast');
    broadcast(state, frame);
    profiler.stop('loop.broadcast');
    if (state.match.phase === 'finished') void finish();
    return { retired: false, live: true, stepped: simulated };
  }

  /** Dispose this room's simulations and detach all remaining clients. */
  function onDispose() {
    if (!state || state.disposed) return;
    state.disposed = true;
    discardRecording();
    const clientIds = [...clientMap.keys()];
    state.waiting?.dispose();
    state.waiting = null;
    state.match?.dispose();
    clientMap.clear();
    state.clients.clear();
    notifyDispose(state.id, clientIds);
  }

  /** Graceful shutdown for this room: stop live play, flush archive, dispose worlds, await pending setup. */
  function close() {
    if (!state) return Promise.resolve();
    if (state.closingPromise) return state.closingPromise;
    state.closing = true;
    discardRecording();
    if (state.started && !state.finished) {
      state.match.end();
      record(state.match.snapshot());
      void finish();
    }
    const waitingReady = state.waiting?.ready;
    state.waiting?.dispose();
    state.waiting = null;
    state.match?.dispose();
    state.closingPromise = Promise.all([state.initializing, waitingReady, state.finalization]).then(() => {
      state.disposed = true;
      clientMap.clear();
      state.clients.clear();
    });
    return state.closingPromise;
  }

  /** Public summary for the room directory (`null` once finished or disposed). */
  function summary() {
    if (!state || state.finished || state.disposed) return null;
    return {
      id: state.id,
      name: state.name,
      kind: state.matchmade ? 'matchmade' : 'private',
      phase: state.started ? 'live' : 'lobby',
      ready: !!state.match,
      size: zoneSizeName(state.size),
      createdAt: state.createdAt,
      players: byRole(role => state.seats.roster().filter(p => p.role === role).length),
      open: byRole(role => state.seats.openPlaces(role)),
    };
  }

  /**
   * Plain health counters for the room host: `live`, `emptyLive`, and the `fast` messages sent so far on datagrams
   * (`fastDatagrams`), the deltas among them over one fragment (`fastFragmentedDeltas`), and those too large for
   * datagrams, sent on the stream (`fastStreamed`).
   */
  function metrics() {
    const live = Boolean(state && state.started && !state.finished), sends = state?.fastSends;
    return {
      live, emptyLive: live && state.clients.size === 0,
      fastDatagrams: sends?.datagrams ?? 0, fastFragmentedDeltas: sends?.fragmentedDeltas ?? 0, fastStreamed: sends?.streamed ?? 0,
    };
  }

  return {
    onCreate,
    onJoin,
    onLeave,
    onMessage,
    onInvalidMessage,
    onDispose,
    adoptMap,
    failMap,
    setViewLag,
    onAck,
    tick,
    close,
    summary,
    metrics,
    // Diagnostic accessors retained for in-process tests and benchmarks (never production directory/HTTP code).
    get id() { return state?.id; },
    get ownerKey() { return state?.ownerKey; },
    get seed() { return state?.seed; },
    get size() { return state?.size; },
    get name() { return state?.name; },
    get matchmade() { return state?.matchmade; },
    get createdAt() { return state?.createdAt; },
    get ready() { return state?.ready; },
    get content() { return state?.content; },
    get presentation() { return state?.presentation; },
    get seats() { return state?.seats; },
    get match() { return state?.match; },
    get game() { return state?.game; },
    get clients() { return state?.clients; },
    get started() { return state?.started; },
    get finished() { return state?.finished; },
    get inputs() { return state?.inputs; },
    get debt() { return state?.debt; },
    get spectators() { return state?.spectators; },
    get history() { return state?.history; },
    get resumes() { return state?.resumes; },
    get layerEncoders() { return state?.layerEncoders; },
    get discoveryEncoders() { return state?.discoveryEncoders; },
    get waiting() { return state?.waiting; },
    get waitingDebt() { return state?.waitingDebt; },
    get pausedAt() { return state?.pausedAt; },
    get finalization() { return state?.finalization; },
    get startsAt() { return state?.startsAt; },
    set startsAt(value) { if (state) state.startsAt = value; },
    get emptySince() { return state?.emptySince; },
    set emptySince(value) { if (state) state.emptySince = value; },
  };
}
