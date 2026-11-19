import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

/**
 * A UDP relay on loopback that applies a network profile (tests/helpers/network-profiles.js) to every packet in both
 * directions: half the rtt plus exponential jitter, independent loss, or bursty outages per `tick` ms slot. QUIC's
 * handshake, acknowledgements and retransmissions all cross it (42.56). Each packet draws its own delay, so packets
 * overtake each other far more than on a real path; `ordered: true` in the profile keeps each direction in order
 * instead, so jitter delays the packets behind a late one as a queue does.
 *
 * It runs on its own thread. Windows' setTimeout is coarse (about 15 ms), which would add its own jitter to every
 * relayed packet, so the relay spins (setImmediate) while any packet is in flight and checks each one's due time. On
 * the main thread that spin delayed the caller's timers (review 906 on PR #1172: lan sent about 347 frames in 20 s
 * instead of 400), and a timer armed for a late packet held back earlier ones; a thread of its own does neither.
 */
const RELAY = `
const { parentPort, workerData } = require('node:worker_threads');
const dgram = require('node:dgram');
const { target, seed, tick } = workerData;
let profile = workerData.profile;
const now = () => performance.timeOrigin + performance.now();
let a = seed >>> 0;
const random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const relay = dgram.createSocket('udp4'), upstream = dgram.createSocket('udp4');
const counts = { up: 0, down: 0, upDropped: 0, downDropped: 0 };
const start = now();
let stay, enter;
const configure = () => { stay = profile.burst ? 1 - 1 / profile.burst : 0; enter = profile.burst ? profile.loss * (1 - stay) / (1 - profile.loss) : 0; };
configure();
const outage = { up: [], down: [] };
const inOutage = dir => { const slot = Math.floor((now() - start) / tick), o = outage[dir];
  while (o.length <= slot) o.push(o.length && o.at(-1) ? random() < stay : random() < enter); return o[slot]; };
const lost = dir => profile.burst ? inOutage(dir) : random() < profile.loss;
const delay = () => profile.rtt / 2 - profile.jitter * Math.log(1 - random());
// Ordered, a packet never leaves before one that arrived ahead of it in its direction: jitter as queueing makes it.
const last = { up: 0, down: 0 };
const due = dir => { const t = now() + delay(); return profile.ordered ? (last[dir] = Math.max(last[dir], t)) : t; };
const pending = [];
let spinning = false, closed = false;
const at = (due, fn) => { pending.push({ due, fn }); if (!spinning) { spinning = true; setImmediate(spin); } };
// Packets due by now leave in due order, earliest first and in arrival order among equals. Sending them last-first
// (as 42.56's relay did) reversed every packet due in the same pass, which an ordered profile makes common.
function spin() {
  const t = now(), ready = [];
  for (let i = 0; i < pending.length;) if (pending[i].due <= t) ready.push(pending.splice(i, 1)[0]); else i++;
  ready.sort((a, b) => a.due - b.due);
  for (const packet of ready) packet.fn();
  if (!pending.length || closed) { spinning = false; return; }
  setImmediate(spin);
}
let client = null;
relay.on('message', (m, from) => {
  client = from; counts.up++;
  if (lost('up')) { counts.upDropped++; return; }
  at(due('up'), () => upstream.send(m, target, '127.0.0.1'));
});
upstream.on('message', m => {
  counts.down++;
  if (!client) return;
  if (lost('down')) { counts.downDropped++; return; }
  const to = client;
  at(due('down'), () => relay.send(m, to.port, to.address));
});
relay.bind(0, '127.0.0.1', () => parentPort.postMessage({ port: relay.address().port }));
parentPort.on('message', message => {
  if (message.profile) { profile = message.profile; outage.up.length = outage.down.length = 0; configure(); parentPort.postMessage({ counts: { ...counts } }); return; }
  if (message.counts) { parentPort.postMessage({ counts: { ...counts } }); return; }
  closed = true; pending.length = 0;
  relay.close(); upstream.close();
  parentPort.postMessage({ counts });
});
`;

/**
 * Starts a relay to UDP `target` on 127.0.0.1. Resolves to `{ port, counts(), update(profile), stop() }`: `port` is
 * where clients send, `counts()` resolves to the packets seen and dropped each way so far, `update` changes the
 * profile from now on (resolving to the counts before it), and `stop` closes the relay and resolves to its counts.
 */
export async function startLossyRelay({ target, profile, seed, tick = 50 }) {
  const worker = new Worker(RELAY, { eval: true, workerData: { target, profile, seed, tick } });
  const { port } = (await once(worker, 'message'))[0];
  const ask = async message => { worker.postMessage(message); return (await once(worker, 'message'))[0].counts; };
  return {
    port,
    counts: () => ask({ counts: true }),
    update: next => ask({ profile: next }),
    async stop() { const counts = await ask({ stop: true }); await worker.terminate(); return counts; },
  };
}
