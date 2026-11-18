import { Worker } from 'node:worker_threads';
import { randomUUID, randomBytes } from 'node:crypto';
import { ROLES } from '../shared/simulation/rules.ts';
import { zoneSizeName } from '../map/live.ts';
import { isPackedMap, packMap, packedTransfer } from './map-pack.js';
import { deliverable } from './protocol.js';

const byRole = count => Object.fromEntries(ROLES.map(role => [role, count(role)]));
const asError = plain => Object.assign(new Error(plain.message), plain.stack ? { stack: plain.stack } : {});

/**
 * The host's side of a room running on its own worker thread (room-worker.js, #1089). It answers the host
 * as an in-process room (room.js) does, so the room service runs either behind one interface: `onJoin`,
 * `onLeave`, `onMessage`, `onInvalidMessage`, `setViewLag`, `close`, `summary`, `metrics`. What differs is
 * time and answers: the room ticks on its own scheduler (`tick` here only reports), a join is answered later
 * through `joined`, and `summary`/`metrics` are the room's latest report, adjusted for joins still in flight
 * so the directory never offers the same last place twice.
 *
 * `map` is a map, a promise of one, a packed map (map-pack.js) or a promise of one, or absent to generate in
 * the room's thread. A map the generator packed reaches the room without the host decoding it; a plain map
 * (a test's) is packed here first. Hooks are the host's: `deliver(clientId, bytes, binary)` with the room's own
 * drop decision already made (`binary` for a codec `state` message, else UTF-8 text), `backlog(clientId)` the socket's buffered bytes, `closeClient`, `joined`,
 * `onFinalization`, `onDispose(roomId, clientIds)`, `published(meta)`, `reportError`, and `failed(roomId)`
 * when the thread dies unasked.
 */
export function createRoomThread({ seed, matchmade, size, map, name, content, createdAt, devTools, replays, replayFinishTimeoutMs, profile, wireKey = null, hooks }) {
  const id = randomBytes(4).toString('hex'), ownerKey = randomUUID();
  const deferredMap = map !== undefined;
  const worker = new Worker(new URL('./room-worker.js', import.meta.url), {
    workerData: {
      room: { id, ownerKey, seed, matchmade, size, name, content, createdAt, deferredMap },
      devTools, replays, replayFinishTimeoutMs, profile, wireKey,
    },
  });
  const capacity = role => role === 'gladiator' ? content.roster.gladiators.length : content.roster.contestants.length;
  // Until the room first reports, its summary is the empty lobby it is: every place open.
  let summary = {
    id, name, kind: matchmade ? 'matchmade' : 'private', phase: 'lobby', ready: false, size: zoneSizeName(size), createdAt,
    players: byRole(() => 0), open: byRole(capacity),
  };
  let metrics = { live: false, emptyLive: false };
  // Player joins sent and not yet answered, by the role asked for.
  const inFlight = [], inFlightRoles = new Map();
  let ended = false, closing, resolveClosed, resolveReady;
  // The room's archive finalizations still running, each one a promise the host awaits on shutdown.
  const finalizations = [];
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const post = (message, transfer) => { if (!ended) worker.postMessage(message, transfer); };
  // Profile requests awaiting this thread's answer, by request id (#1115).
  const profileRequests = new Map();
  let profileRequestId = 0;

  if (deferredMap) {
    Promise.resolve(map).then(resolved => {
      const packed = isPackedMap(resolved) ? resolved : packMap(resolved);
      post({ op: 'map', map: packed }, packedTransfer(packed));
    }, error => post({ op: 'map-failed', error: { message: error?.message ?? String(error), stack: error?.stack } }));
  }

  function startFinalization() {
    let resolve;
    hooks.onFinalization(new Promise(settle => { resolve = settle; }));
    finalizations.push(resolve);
  }
  const settleFinalization = () => finalizations.shift()?.();

  function stop() {
    if (ended) return;
    ended = true;
    summary = null;
    metrics = { live: false, emptyLive: false };
    resolveReady(); while (finalizations.length) settleFinalization(); resolveClosed();
    for (const resolve of profileRequests.values()) resolve(null);
    profileRequests.clear();
    void worker.terminate();
  }

  function onEvents({ events, payloads }) {
    for (const event of events) {
      switch (event[0]) {
        case 'deliver': hooks.deliver(event[1], payloads[event[2]], event[3]); break;
        case 'close': hooks.closeClient(event[1], event[2], event[3]); break;
        case 'joined': {
          const at = inFlight.indexOf(event[1]);
          if (at >= 0) inFlight.splice(at, 1);
          inFlightRoles.delete(event[1]);
          hooks.joined(event[1], event[2]);
          break;
        }
        case 'summary': summary = event[1]; metrics = event[2]; break;
        case 'profile': { const resolve = profileRequests.get(event[1]); profileRequests.delete(event[1]); resolve?.(event[2]); break; }
        case 'ready': resolveReady(); break;
        case 'published': hooks.published(event[1]); break;
        case 'error': hooks.reportError(asError(event[1])); break;
        case 'finalizing': startFinalization(); break;
        case 'finalized': settleFinalization(); break;
        case 'disposed': hooks.onDispose(id, event[1]); break;
        case 'retired': stop(); break;
        case 'closed': stop(); break;
      }
    }
    // What each delivered client's socket now holds, for the room's next drop decision.
    const entries = [];
    for (const event of events) {
      if (event[0] === 'deliver') entries.push([event[1], hooks.backlog(event[1])]);
      else if (event[0] === 'close') { reported.delete(event[1]); blocked.delete(event[1]); }
    }
    report(entries);
  }

  // The last backlog reported for each client, and those it left blocked: the room skips their state
  // frames, so no delivery would prompt another report, and `refreshBacklog` re-reads them until they drain.
  const reported = new Map(), blocked = new Set();
  function report(entries) {
    if (!entries.length) return;
    for (const [clientId, bytes] of entries) {
      reported.set(clientId, bytes);
      if (deliverable(bytes, true)) blocked.delete(clientId); else blocked.add(clientId);
    }
    post({ op: 'backlog', entries });
  }
  function refreshBacklog() {
    const entries = [];
    for (const clientId of blocked) {
      const bytes = hooks.backlog(clientId);
      if (bytes !== reported.get(clientId)) entries.push([clientId, bytes]);
    }
    report(entries);
  }

  worker.on('message', onEvents);
  worker.on('error', error => { if (!ended) { hooks.reportError(error); hooks.failed(id); stop(); } });
  worker.on('exit', code => { if (!ended) { hooks.reportError(new Error(`Room ${id} thread exited with code ${code}`)); hooks.failed(id); stop(); } });

  return {
    id, ownerKey, seed, size, name, matchmade, createdAt, ready,
    descriptor: { id, ownerKey, seed, size, name, ready },
    get finished() { return summary === null; },
    /** Joins are answered through the host's `joined` hook once the room has decided. */
    onJoin(clientId, options) {
      if (options.mode !== 'dev' && options.mode !== 'spectator') {
        inFlight.push(clientId);
        inFlightRoles.set(clientId, options.role === 'gladiator' ? 'gladiator' : 'contestant');
      }
      post({ op: 'join', clientId, options });
    },
    onLeave(clientId) { reported.delete(clientId); blocked.delete(clientId); post({ op: 'leave', clientId }); return true; },
    onMessage(clientId, data) { post({ op: 'message', clientId, data }); },
    onInvalidMessage(clientId, info) { post({ op: 'invalid', clientId, info }); },
    setViewLag(clientId, rttMs) { post({ op: 'lag', clientId, rttMs }); return true; },
    setProfiling(enabled) { post({ op: 'profile', enabled }); },
    /**
     * The room thread's own profiler series, `{ frames, series }`, or null once the thread has ended or when it
     * has not answered within `timeoutMs` (a thread stalled in a long tick must not hold up the endpoint).
     */
    profile(timeoutMs = 2000) {
      if (ended) return Promise.resolve(null);
      const requestId = ++profileRequestId;
      return new Promise(resolve => {
        const timer = setTimeout(() => { profileRequests.delete(requestId); resolve(null); }, timeoutMs);
        profileRequests.set(requestId, value => { clearTimeout(timer); resolve(value); });
        post({ op: 'profile-report', requestId });
      });
    },
    /** The room keeps its own time; the host's wake only reports it, and how far blocked sockets have drained. */
    tick() {
      refreshBacklog();
      return { retired: false, live: metrics.live, stepped: 0 };
    },
    close() {
      if (!closing) {
        closing = closed;
        post({ op: 'close' });
        if (ended) resolveClosed();
      }
      return closing;
    },
    summary() {
      if (!summary || !inFlight.length) return summary;
      const open = { ...summary.open };
      for (const clientId of inFlight) {
        const asked = inFlightRoles.get(clientId), other = asked === 'gladiator' ? 'contestant' : 'gladiator';
        if (open[asked] > 0) open[asked]--; else if (open[other] > 0) open[other]--;
      }
      return { ...summary, open };
    },
    metrics: () => metrics,
    /** The room's thread itself: a diagnostic for tests (a thread that dies unasked), never application code. */
    get worker() { return worker; },
  };
}
