// Input-timing study (#1096): how three ways of spending client input behave under simulated latency, jitter and
// loss. No physics runs; the model is the input path only, so it takes seconds and needs no machine lock.
//
//   A  today's arrival-order queue: the real `queueInput`/`consumeInput` from shared/simulation/input.ts, with the
//      client sending on a free-running 20 Hz clock as it does today.
//   B  tick-stamped inputs with a server jitter buffer (#1096 option 1, or option 3 with rewind for hits). Stamps
//      advance exactly one tick per input, so one tick spends at most one input and sequence order is kept. The
//      client controls how far ahead its inputs land by adjusting its send rate (time dilation): faster after a
//      late input, slower while every recent input arrived with more than the target margin. A late input is
//      discarded, the world is never rewound for movement, and a stamp too far ahead is refused.
//   C  delayed sealing: B's client and stamps, but a late input inside the sealing window W is applied by
//      resimulating from its tick rather than discarded (#1096 option 2). Only the resimulation load is modelled.
//   R  the implementation of B as built (#1096): the real client clock (`shared/input-clock.ts`), fed by frames
//      that carry the server's reported margin, and the real buffer (`queueInput`/`consumeInput`) with its lead
//      bounded by the round trip. A and R share each profile's seeded network.
//
// Time is milliseconds. Each profile is replayed with the same seeded network for every policy. Usage:
//   node tests/bench-input-timing.mjs [--seconds=600] [--players=8] [--seed=1096] [--tick-ms=3.7,7.7,16.1]
import { queueInput, consumeInput, resetInput, inputLeadFrom } from '../shared/simulation/input.ts';
import { createInputClock } from '../shared/input-clock.ts';
import { HZ } from '../shared/simulation/rules.ts';
import { cliArgs } from './helpers/args.js';
import { INDEPENDENT_PROFILES } from './helpers/network-profiles.js';

const args = cliArgs();
const seconds = Number(args.get('seconds') ?? 600), players = Number(args.get('players') ?? 8), seed = Number(args.get('seed') ?? 1096);
// Whole-tick cost at 36x18 from docs/42.22's 2026-11-09 multi-room check (main a837cc0, content-7, 8 clients plus a
// spectator, recording on), upper ends of the ranges: one room's simulation alone (tick mean 7.70 less broadcast
// 3.68 and recording 0.33), one room's whole tick, and two rooms sharing one loop. A resimulated tick re-runs the
// simulation, not broadcast, so the first is the closest estimate. Restore cost is not included at all because no
// production exact restore exists (29.2).
const tickCosts = (args.get('tick-ms') ?? '3.7,7.7,16.1').split(',').map(Number);
const costLabels = args.has('tick-ms') ? tickCosts.map(c => `${c} ms`) : ['1 room sim only', '1 room whole tick', '2 rooms whole tick'];
const TICK = 1000 / HZ, TICKS = Math.floor(seconds * HZ), WARMUP = 10 * HZ;
// A stamp further ahead than this is refused: it bounds the jitter buffer, and a claimed past is never honoured.
const MAX_LEAD = 10;
// Time dilation: how much faster a client sends after a late input, and how much slower while it is too far ahead.
const SPEED_UP = 0.9, SLOW_DOWN = 1.05, WINDOW = 20;

// rtt and jitter in ms; jitter is the mean of an exponential extra delay on each one-way trip. `ws` is a reliable
// ordered socket, where loss becomes a stall that also holds every later packet; `dg` is an unreliable datagram,
// where loss is real and packets can pass each other.
const profiles = INDEPENDENT_PROFILES;

function rng(s) { let a = s >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pct = (xs, q) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const tickOf = a => Math.ceil(a / TICK);

/**
 * One client's network, drawn independently of when it sends: per-input forward delay (Infinity when a datagram is
 * lost) and the return delay of the server's acknowledgement. Several inputs need a slot past TICKS because a client
 * that speeds up sends more than one per tick.
 */
function network(profile, transport, r) {
  const n = TICKS * 2, fwd = new Float64Array(n), back = new Float64Array(n);
  const oneWay = () => profile.rtt / 2 - profile.jitter * Math.log(1 - r());
  for (let k = 0; k < n; k++) {
    fwd[k] = oneWay(); back[k] = oneWay();
    if (r() < profile.loss) fwd[k] = transport === 'dg' ? Infinity : fwd[k] + Math.max(200, profile.rtt * 1.5);
  }
  return { fwd, back, transport, phase: r() * TICK };
}
/** Arrival times for a send schedule; a reliable socket also holds each packet behind the one before it. */
function arrivals(net, sendT) {
  const arr = sendT.map((t, k) => t + net.fwd[k]);
  if (net.transport === 'ws') for (let k = 1; k < arr.length; k++) arr[k] = Math.max(arr[k], arr[k - 1]);
  return arr;
}

function policyA(net) {
  const sendT = Array.from({ length: TICKS }, (_, k) => net.phase + k * TICK), arr = arrivals(net, sendT);
  const order = arr.map((a, k) => k).filter(k => arr[k] < Infinity).sort((i, j) => arr[i] - arr[j]);
  const p = {}; resetInput(p);
  const delays = [], depths = []; let next = 0, stalls = 0, rejected = 0, measured = 0, spent = 0, lastSpent = -1;
  for (let n = 0; n < TICKS; n++) {
    while (next < order.length && arr[order[next]] <= n * TICK) { const k = order[next++]; if (!queueInput(p, { seq: k, x: 1 }, n) && n >= WARMUP) rejected++; }
    const depth = p.inputQueue.length;
    consumeInput(p, n);
    if (n < WARMUP) { lastSpent = p.lastSeq; continue; }
    measured++; depths.push(depth);
    if (depth === 0) stalls++;
    if (p.lastSeq !== lastSpent) { lastSpent = p.lastSeq; spent++; delays.push(n * TICK - sendT[p.lastSeq]); }
  }
  return { delays, stallRate: stalls / measured, rejectedRate: rejected / measured, queueMean: mean(depths) };
}

/**
 * B's client and server together. The client sends input k stamped `stamp0 + k` and chooses when to send the next
 * one from acknowledgements it has received (each one a round trip late): an acknowledgement reports the margin, in
 * ticks, by which its input arrived ahead of its stamp. `target` is the margin the client aims to keep.
 */
function policyB(net, target) {
  const sendT = [], arr = [], stamp = [];
  let t = net.phase, stamp0 = null, period = TICK;
  const known = [], margins = [];
  let pending = [];
  const delays = []; let buffer = new Map(), late = 0, capped = 0, stalls = 0, spent = 0, measured = 0, k = 0, n = 0;
  const periods = [], lateEvents = [];
  const deliver = upTo => {
    // Send every input due before the server tick at `upTo` starts.
    while (t <= upTo) {
      // Fold in acknowledgements that have reached the client by now.
      pending = pending.filter(j => {
        const ackAt = Math.max(arr[j], tickOf(arr[j]) * TICK) + net.back[j];
        if (ackAt > t) return true;
        margins.push(stamp[j] - tickOf(arr[j])); if (margins.length > WINDOW) margins.shift();
        return false;
      });
      // The origin comes from a time-sync estimate (the best of the first 20 one-way times), not from input 0, which a
      // datagram link may lose.
      if (stamp0 === null) stamp0 = tickOf(t + Math.min(...Array.from({ length: 20 }, (_, i) => net.fwd[i]).filter(Number.isFinite))) + target;
      const recentLate = margins.slice(-3).some(m => m < 0);
      period = recentLate || (margins.length && Math.min(...margins) < target) ? TICK * SPEED_UP
        : margins.length >= WINDOW && Math.min(...margins) > target ? TICK * SLOW_DOWN : TICK;
      sendT[k] = t; stamp[k] = stamp0 + k;
      arr[k] = t + net.fwd[k];
      if (net.transport === 'ws' && k > 0) arr[k] = Math.max(arr[k], arr[k - 1]);
      if (arr[k] < Infinity) { known.push(k); pending.push(k); }
      k++; t += period;
      if (n >= WARMUP) periods.push(period);
    }
  };
  let inFlight = [];
  for (n = 0; n < TICKS; n++) {
    deliver(n * TICK);
    // Server: admit everything that has arrived by this tick's start.
    inFlight = inFlight.concat(known.splice(0));
    inFlight = inFlight.filter(j => {
      if (arr[j] > n * TICK) return true;
      if (stamp[j] < n) { if (n >= WARMUP) { late++; lateEvents.push({ n, behind: n - stamp[j] }); } return false; }
      if (stamp[j] > n + MAX_LEAD) { if (n >= WARMUP) capped++; return false; }
      buffer.set(stamp[j], j); return false;
    });
    const j = buffer.get(n); buffer.delete(n);
    if (n < WARMUP) continue;
    measured++;
    if (j === undefined) stalls++; else { spent++; delays.push(n * TICK - sendT[j]); }
  }
  return { delays, stallRate: stalls / measured, lateRate: late / measured, cappedRate: capped / measured, rateMean: TICK / mean(periods), lateEvents };
}

/**
 * R: the implementation. The client sends when its clock says, stamps from its own estimate of the server's tick,
 * and steers by the margin each frame reports; frames leave the server after each tick and take the return delay
 * of the same seeded network (ordered on the reliable socket). The server admits every input that has arrived by a
 * tick's start, then spends one. The round trip the server measures is taken as the profile's.
 */
function policyR(net, target, rtt) {
  const clock = createInputClock({ target }), p = {}; resetInput(p); p.inputLeadTicks = inputLeadFrom(rtt);
  const sendT = [], arr = [], stamp = [], delays = [];
  let frames = [], inFlight = [], nextSend = net.phase, lastFrameAt = 0, lastArr = 0;
  let measured = 0, stalls = 0, late = 0, capped = 0, refused = 0;
  for (let n = 1; n < TICKS; n++) {
    const T = n * TICK;
    // Client events before this tick, in time order: frames arriving and inputs due.
    for (;;) {
      const frameAt = frames[0]?.at ?? Infinity;
      if (Math.min(frameAt, nextSend) > T) break;
      if (frameAt <= nextSend) { const fr = frames.shift(); clock.observe(fr.tick, fr.at, fr.margin); continue; }
      const at = nextSend, tick = clock.stamp(at, rtt);
      if (tick === null) { nextSend += TICK; continue; }
      const k = sendT.length;
      sendT[k] = at; stamp[k] = tick; arr[k] = at + net.fwd[k];
      if (net.transport === 'ws') arr[k] = lastArr = Math.max(arr[k], lastArr);
      if (arr[k] < Infinity) inFlight.push(k);
      nextSend = at + clock.delay(at);
    }
    // Server: admit what has arrived, in arrival order, then spend one input.
    inFlight.sort((i, j) => arr[i] - arr[j]);
    while (inFlight.length && arr[inFlight[0]] <= T) {
      const k = inFlight.shift();
      if (queueInput(p, { seq: k, tick: stamp[k], x: 1 }, n - 1) || n < WARMUP) continue;
      const margin = stamp[k] - n;
      if (margin < 0) late++; else if (margin > p.inputLeadTicks) capped++; else refused++;
    }
    const before = p.lastSeq;
    consumeInput(p, n);
    let at = T + net.back[n];
    if (net.transport === 'ws') at = lastFrameAt = Math.max(at, lastFrameAt);
    frames.push({ at, tick: n, margin: p.inputMargin });
    if (net.transport !== 'ws') frames.sort((a, b) => a.at - b.at);
    if (n < WARMUP) continue;
    measured++;
    if (p.lastSeq === before) stalls++; else delays.push(T - sendT[p.lastSeq]);
  }
  return { delays, stallRate: stalls / measured, lateRate: late / measured, cappedRate: capped / measured, refusedRate: refused / measured };
}

const f = (x, d = 1) => x.toFixed(d), p = x => `${f(x * 100, 1)}%`;
const nets = (profile, transport) => Array.from({ length: players }, (_, i) => network(profile, transport, rng(seed + i * 7919 + profile.rtt)));
const agg = (rs, key) => mean(rs.map(r => r[key]));
const pooled = (rs, key) => rs.flatMap(r => r[key]);

console.log(`# Input timing model (#1096): ${seconds}s per cell, ${players} clients, ${HZ} Hz, seed ${seed}\n`);
for (const [transport, label] of [['ws', 'reliable ordered socket'], ['dg', 'unreliable datagrams']]) {
  console.log(`## A. Arrival-order queue (today), ${label}\n`);
  console.log('| profile | rtt/jitter/loss | spend delay mean / p95 ms | extra over one-way ms | queue depth mean | starved ticks | rejected out of order |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const q of profiles) {
    const rs = nets(q, transport).map(policyA), d = pooled(rs, 'delays');
    console.log(`| ${q.name} | ${q.rtt}/${q.jitter}/${p(q.loss)} | ${f(mean(d))} / ${f(pct(d, 0.95))} | ${f(mean(d) - q.rtt / 2)} | ${f(agg(rs, 'queueMean'), 2)} | ${p(agg(rs, 'stallRate'))} | ${p(agg(rs, 'rejectedRate'))} |`);
  }
  console.log('');
}
for (const [transport, label] of [['ws', 'reliable ordered socket'], ['dg', 'unreliable datagrams']]) {
  console.log(`## B. Tick-stamped, jitter buffer, client time dilation, ${label}\n`);
  console.log('| profile | target margin | spend delay mean / p95 ms | extra over one-way ms | starved ticks | late, discarded | over the lead cap | mean send rate / tick rate |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const q of profiles) for (const target of [0, 1, 2]) {
    const rs = nets(q, transport).map(net => policyB(net, target)), d = pooled(rs, 'delays');
    console.log(`| ${q.name} | ${target} | ${f(mean(d))} / ${f(pct(d, 0.95))} | ${f(mean(d) - q.rtt / 2)} | ${p(agg(rs, 'stallRate'))} | ${p(agg(rs, 'lateRate'))} | ${p(agg(rs, 'cappedRate'))} | ${f(agg(rs, 'rateMean'), 3)} |`);
  }
  console.log('');
}

for (const [transport, label] of [['ws', 'reliable ordered socket'], ['dg', 'unreliable datagrams']]) {
  console.log(`## R. The implementation (shared/input-clock.ts, shared/simulation/input.ts), ${label}\n`);
  console.log('| profile | target margin | lead cap ticks | spend delay mean / p95 ms | starved ticks | late, discarded | over the lead cap | out of order |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const q of profiles) for (const target of [0, 1]) {
    const rs = nets(q, transport).map(net => policyR(net, target, q.rtt)), d = pooled(rs, 'delays');
    console.log(`| ${q.name} | ${target} | ${inputLeadFrom(q.rtt)} | ${f(mean(d))} / ${f(pct(d, 0.95))} | ${p(agg(rs, 'stallRate'))} | ${p(agg(rs, 'lateRate'))} | ${p(agg(rs, 'cappedRate'))} | ${p(agg(rs, 'refusedRate'))} |`);
  }
  console.log('');
}

console.log('## C. Delayed sealing: resimulation load, reliable ordered socket\n');
console.log('C keeps B\'s client and stamps, but a late input within the window is applied by resimulating from its tick');
console.log('instead of being discarded. The late inputs are B\'s at the same target margin, so a smaller margin trades');
console.log(`input delay for resimulation. Cost per tick: ${tickCosts.map((c, i) => `${costLabels[i]} ${c} ms`).join(', ')};`);
console.log(`budget ${f(TICK)} ms. A tick's load is (1 + resimulated ticks) x cost, the deepest late input among ${players} clients.\n`);
console.log(`| profile | target margin | window | late inputs per client | beyond window | ticks with a resim | mean / p99 resim ticks | ${costLabels.map(l => `over budget @${l}`).join(' | ')} |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- | ${costLabels.map(() => '---').join(' | ')} |`);
for (const profile of profiles) for (const target of [0, 1]) {
  const rs = nets(profile, 'ws').map(net => policyB(net, target));
  for (const window of [2, 4, 8]) {
    const depth = new Array(TICKS).fill(0); let beyond = 0;
    for (const r of rs) for (const { n, behind } of r.lateEvents) { if (behind > window) beyond++; else depth[n] = Math.max(depth[n], behind); }
    const merged = depth.slice(WARMUP), hit = merged.filter(x => x > 0), measured = merged.length;
    console.log(`| ${profile.name} | ${target} | ${window} (${window * TICK} ms) | ${p(agg(rs, 'lateRate'))} | ${p(beyond / players / measured)} | ${p(hit.length / measured)} | ${f(mean(hit), 2)} / ${pct(hit, 0.99)} | ${tickCosts.map(c => p(merged.filter(x => (1 + x) * c > TICK).length / measured)).join(' | ')} |`);
  }
}