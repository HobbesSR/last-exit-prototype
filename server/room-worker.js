// One room on its own thread (#1089): the room lifecycle (room.js) with its match, waiting yard, scheduler and
// tick debt, and its recording worker as this thread's child, so no other room's work can delay its ticks or
// its delivery, nor its work theirs. The host thread keeps sessions, sockets, validation, latency and the
// directory; room-thread.js is its side of this conversation.
//
// In: plain messages, in the order the host received them ({ op, ... }; see `handle`).
// Out: batches of events in the order the room produced them, flushed once per turn of this thread's loop,
// with each distinct payload encoded once as UTF-8 bytes and transferred, never copied or re-encoded by the
// host. Whether a droppable state frame is skipped is decided here, against the socket backlog the host last
// reported, so the room knows exactly which keyframes each client was delivered (room-views.js).
import { parentPort, workerData } from 'node:worker_threads';
import * as profiler from '../shared/profiler.ts';
import { deliverable } from './protocol.js';
import { createRoom } from './room.js';
import { startScheduler } from './scheduler.js';
import { fileReplayWriters } from './replay-store.js';
import { mapHere } from './map-pack.js';

const { room: options, devTools, replays: replayOptions, replayFinishTimeoutMs, profile, wireKey } = workerData;
profiler.enable(!!profile);

const encoder = new TextEncoder();
let events = [], payloads = [], payloadIndex = new Map(), scheduled = false, lastSummary;
// The host's last report of each client's socket backlog, plus what this thread has sent it since.
const backlog = new Map();
let finalizing = 0, disposed = false, stopScheduler = () => {};

const asPlainError = error => error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
function emit(event) {
  events.push(event);
  schedule();
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}
function flush() {
  scheduled = false;
  const summary = room.summary(), metrics = room.metrics(), text = JSON.stringify([summary, metrics]);
  if (text !== lastSummary) { lastSummary = text; events.push(['summary', summary, metrics]); }
  if (!events.length) return;
  const out = events, bytes = payloads;
  events = []; payloads = []; payloadIndex = new Map();
  parentPort.postMessage({ events: out, payloads: bytes }, bytes.map(payload => payload.buffer));
}

function deliver(clientId, payload, droppable) {
  const held = backlog.get(clientId) ?? 0;
  if (!deliverable(held, droppable)) return false;
  let index = payloadIndex.get(payload);
  if (index === undefined) {
    index = payloads.length;
    payloadIndex.set(payload, index);
    payloads.push(encoder.encode(payload));
  }
  backlog.set(clientId, held + payloads[index].byteLength);
  emit(['deliver', clientId, index]);
  return true;
}

function retireWhenDone() {
  if (disposed && finalizing === 0) { stopScheduler(); emit(['retired']); }
}

const room = createRoom({
  replays: fileReplayWriters(replayOptions.directory, meta => emit(['published', meta])),
  devTools,
  replayFinishTimeoutMs,
  wireKey,
  reportError: error => emit(['error', asPlainError(error)]),
  deliver,
  closeClient: (clientId, code, reason) => { backlog.delete(clientId); emit(['close', clientId, code, reason]); },
  onFinalization: completion => {
    finalizing++;
    emit(['finalizing']);
    completion.finally(() => { finalizing--; emit(['finalized']); retireWhenDone(); });
  },
  onDispose: (_id, clientIds) => { disposed = true; emit(['disposed', clientIds]); retireWhenDone(); },
});

room.onCreate(options).ready.then(() => emit(['ready']));

stopScheduler = startScheduler((elapsed, now) => {
  profiler.start('loop.tick');
  const result = room.tick(elapsed, now);
  profiler.stop('loop.tick');
  profiler.count('loop.liveRooms', result.live ? 1 : 0);
  profiler.count('loop.simSteps', result.stepped);
  profiler.frame();
});

function handle(message) {
  switch (message.op) {
    case 'map': room.adoptMap(mapHere(message.map)); break;
    case 'map-failed': room.failMap(Object.assign(new Error(message.error.message), message.error.stack ? { stack: message.error.stack } : {})); break;
    case 'join': {
      backlog.set(message.clientId, 0);
      const joined = room.onJoin(message.clientId, message.options);
      if (!joined.ok) backlog.delete(message.clientId);
      emit(['joined', message.clientId, joined]);
      break;
    }
    case 'leave': backlog.delete(message.clientId); room.onLeave(message.clientId, true); break;
    case 'message': room.onMessage(message.clientId, message.data); break;
    case 'invalid': room.onInvalidMessage(message.clientId, message.info); break;
    case 'lag': room.setViewLag(message.clientId, message.rttMs); break;
    case 'backlog': for (const [clientId, bytes] of message.entries) if (backlog.has(clientId)) backlog.set(clientId, bytes); break;
    case 'profile': profiler.enable(message.enabled); break;
    // This thread's profiler series, for the host's profile endpoint and summary (#1115).
    case 'profile-report': emit(['profile', message.requestId, { frames: profiler.frameCount(), series: profiler.report() }]); break;
    case 'close':
      stopScheduler();
      room.close().then(() => emit(['closed']), error => { emit(['error', asPlainError(error)]); emit(['closed']); });
      break;
  }
}

parentPort.on('message', message => {
  try { handle(message); }
  catch (error) { emit(['error', asPlainError(error)]); }
  schedule();
});
