// Input-timing study (#1096): how three ways of spending client input behave under simulated latency, jitter and
// loss. No physics runs; the model is the input path only, so it takes seconds and needs no machine lock.
//
//   A  today's arrival-order queue: the real `queueInput`/`consumeInput` from shared/simulation/input.ts.
//   B  tick-stamped inputs with a server jitter buffer and a client lead that adapts to measured lateness;
//      a late input is dropped, the world is never rewound (#1096 option 1, or option 3 with rewind for hits).
//   C  delayed sealing: inputs stamped as in B but with a minimal lead, a late input inside the sealing window W
//      is applied by resimulating from its tick (#1096 option 2). Only the resimulation load is modelled.
//
// Time is milliseconds, the server ticks at HZ, every client sends one input per tick on a free-running clock, and
// each profile is replayed with the same seeded randomness for every policy. Usage:
//   node tests/bench-input-timing.mjs [--seconds=600] [--players=8] [--seed=1096] [--tick-ms=7.4,17.8,34]
import { queueInput, consumeInput, resetInput } from '../shared/simulation/input.ts';
import { HZ } from '../shared/simulation/rules.ts';
import { cliArgs } from './helpers/args.js';

const args = cliArgs();
const seconds = Number(args.get('seconds') ?? 600), players = Number(args.get('players') ?? 8), seed = Number(args.get('seed') ?? 1096);
// Mean simulation cost per tick at 12x6, 24x12 and 36x18 (docs/42.22); the budget is one tick period.
const tickCosts = (args.get('tick-ms') ?? '7.4,17.8,34').split(',').map(Number);
// A stamp further ahead than this is refused: it bounds the jitter buffer, and a claimed past is never honoured.
const MAX_LEAD = 10;
const TICK = 1000 / HZ, TICKS = Math.floor(seconds * HZ), WARMUP = 3 * HZ;

// rtt and jitter in ms; jitter is the mean of an exponential extra delay on each one-way trip. `ws` is a reliable
// ordered socket, where loss becomes a stall that also holds every later packet; `dg` is an unreliable datagram,
// where loss is real and packets can pass each other.
const profiles = [
  { name: 'lan', rtt: 4, jitter: 1, loss: 0 },
  { name: 'good', rtt: 40, jitter: 4, loss: 0.002 },
  { name: 'typical', rtt: 80, jitter: 12, loss: 0.01 },
  { name: 'wifi', rtt: 120, jitter: 35, loss: 0.03 },
  { name: 'poor', rtt: 220, jitter: 70, loss: 0.05 },
];

function rng(s) { let a = s >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pct = (xs, q) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Send and arrival times of every input one client sends over one link; `Infinity` is a lost datagram. */
function link(profile, transport, r) {
  const phase = r() * TICK, sendT = [], arr = [];
  let lastArrival = 0;
  for (let k = 0; k < TICKS; k++) {
    const t = phase + k * TICK;
    let a = t + profile.rtt / 2 - profile.jitter * Math.log(1 - r());
    if (r() < profile.loss) {
      if (transport === 'dg') a = Infinity;
      else a += Math.max(200, profile.rtt * 1.5); // retransmission timeout
    }
    if (transport === 'ws') { a = Math.max(a, lastArrival); lastArrival = a; }
    sendT.push(t); arr.push(a);
  }
  return { sendT, arr, phase };
}
const arrivalOrder = l => l.arr.map((a, k) => k).filter(k => l.arr[k] < Infinity).sort((i, j) => l.arr[i] - l.arr[j]);
// Input available to server tick n: everything that has arrived by that tick's start.
const tickOf = a => Math.ceil(a / TICK);

function policyA(l) {
  const p = {}; resetInput(p);
  const order = arrivalOrder(l); let next = 0;
  const delays = [], depths = [], spentSeqs = new Set(); let stalls = 0, rejected = 0, idle = 0, measured = 0, lastSpent = -1;
  for (let n = 0; n < TICKS; n++) {
    while (next < order.length && l.arr[order[next]] <= n * TICK) { const k = order[next++]; if (!queueInput(p, { seq: k, x: 1 }, n)) rejected++; }
    const depth = p.inputQueue.length;
    consumeInput(p, n);
    if (n < WARMUP) continue;
    measured++; depths.push(depth);
    if (p.lastSeq !== lastSpent) { lastSpent = p.lastSeq; spentSeqs.add(p.lastSeq); delays.push(n * TICK - l.sendT[p.lastSeq]); }
    else if (!p.input.x && p.input.x !== 0) idle++;
    if (depth === 0) { stalls++; if (!p.input.x) idle++; }
  }
  const sent = TICKS - WARMUP;
  return { delays, depths, stallRate: stalls / measured, idleRate: idle / measured, lostRate: Math.max(0, 1 - spentSeqs.size / sent) , rejectedRate: rejected / sent, queueMean: mean(depths) };
}

/** Client-side stamping shared by B and C: aim at the server tick an input should be spent on. */
function stamper(l, lead0, adaptive) {
  const recent = []; let owd = l.arr.find(a => a < Infinity) - l.sendT[0], lead = lead0, last = -1, margins = [];
  const stamp = new Array(TICKS), on = new Array(TICKS);
  const order = arrivalOrder(l);
  // The estimate is the minimum of the last 20 one-way times, the same shape as the server's ping figure (24), so a stall
  // cannot inflate it. The estimate and the lead only learn from arrivals, in arrival order, so stamps for inputs sent before an
  // arrival cannot use it. Walk send times and fold in arrivals up to each send time.
  let next = 0;
  for (let k = 0; k < TICKS; k++) {
    while (next < order.length && l.arr[order[next]] <= l.sendT[k]) {
      const j = order[next++]; recent.push(l.arr[j] - l.sendT[j]); if (recent.length > 20) recent.shift(); owd = Math.min(...recent);
      const m = stamp[j] - tickOf(l.arr[j]); on[j] = m;
      if (adaptive) {
        if (m < 0) { lead = Math.min(lead + 1, 8); margins = []; }
        else { margins.push(m); if (margins.length >= 20) { if (Math.min(...margins) >= 2) lead = Math.max(lead0, lead - 1); margins = []; } }
      }
    }
    stamp[k] = last = Math.max(last + 1, tickOf(l.sendT[k] + owd) + lead);
  }
  return { stamp, order };
}

function policyB(l, maxLeadTicks) {
  const { stamp, order } = stamper(l, 0, true);
  const buffer = new Map(), delays = []; let next = 0, stalls = 0, late = 0, capped = 0, spent = 0, measured = 0, leadSum = 0;
  for (let n = 0; n < TICKS; n++) {
    while (next < order.length && l.arr[order[next]] <= n * TICK) {
      const k = order[next++];
      if (stamp[k] < n) { if (n >= WARMUP) late++; continue; }
      if (stamp[k] > n + maxLeadTicks) { capped++; continue; }
      if (!buffer.has(stamp[k])) buffer.set(stamp[k], k);
    }
    const k = buffer.get(n); buffer.delete(n);
    if (n < WARMUP) continue;
    measured++;
    if (k === undefined) stalls++; else { spent++; delays.push(n * TICK - l.sendT[k]); }
  }
  return { delays, stallRate: stalls / measured, lateRate: late / (TICKS - WARMUP), cappedRate: capped / (TICKS - WARMUP), lostRate: 1 - spent / measured };
}

function policyC(l, window) {
  const { stamp, order } = stamper(l, 0, false);
  const resim = new Array(TICKS).fill(0); let next = 0, late = 0, dropped = 0;
  const arrivals = order.map(k => ({ k, n: tickOf(l.arr[k]) }));
  for (const { k, n } of arrivals) {
    if (n >= TICKS) continue;
    const behind = n - stamp[k];
    if (behind <= 0) continue;
    if (n >= WARMUP) { if (behind > window) dropped++; else late++; }
    if (behind <= window) resim[n] = Math.max(resim[n], behind);
  }
  return { resim, lateRate: late / (TICKS - WARMUP), droppedRate: dropped / (TICKS - WARMUP) };
}

const f = (x, d = 1) => x.toFixed(d), p = x => `${f(x * 100, 1)}%`;
const run = (transport, name, one) => profiles.map(profile => {
  const rs = Array.from({ length: players }, (_, i) => one(link(profile, transport, rng(seed + i * 7919 + profile.rtt))));
  return { profile, rs };
});
const agg = (rs, key) => mean(rs.map(r => r[key]));
const pooled = (rs, key) => rs.flatMap(r => r[key]);

console.log(`# Input timing model (#1096): ${seconds}s per cell, ${players} clients, ${HZ} Hz, seed ${seed}\n`);
console.log('## A. Arrival-order queue (today), reliable ordered socket\n');
console.log('| profile | rtt/jitter/loss | spend delay mean / p95 ms | extra over one-way ms | queue depth mean | starved ticks | input never spent |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const { profile: q, rs } of run('ws', 'A', policyA)) {
  const d = pooled(rs, 'delays');
  console.log(`| ${q.name} | ${q.rtt}/${q.jitter}/${p(q.loss)} | ${f(mean(d))} / ${f(pct(d, 0.95))} | ${f(mean(d) - q.rtt / 2)} | ${f(agg(rs, 'queueMean'), 2)} | ${p(agg(rs, 'stallRate'))} | ${p(agg(rs, 'lostRate'))} |`);
}
console.log('\n## A on unreliable datagrams (reorder and real loss), same queue\n');
console.log('| profile | spend delay mean / p95 ms | queue depth mean | starved ticks | rejected as out of order | never spent |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const { profile: q, rs } of run('dg', 'A', policyA)) {
  const d = pooled(rs, 'delays');
  console.log(`| ${q.name} | ${f(mean(d))} / ${f(pct(d, 0.95))} | ${f(agg(rs, 'queueMean'), 2)} | ${p(agg(rs, 'stallRate'))} | ${p(agg(rs, 'rejectedRate'))} | ${p(agg(rs, 'lostRate'))} |`);
}
for (const [transport, label] of [['ws', 'reliable ordered socket'], ['dg', 'unreliable datagrams']]) {
  console.log(`\n## B. Tick-stamped with jitter buffer and adaptive lead, ${label}\n`);
  console.log('| profile | spend delay mean / p95 ms | extra over one-way ms | starved ticks (repeat) | late, discarded | over the latency cap |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const { profile: q, rs } of run(transport, 'B', l => policyB(l, MAX_LEAD))) {
    const d = pooled(rs, 'delays');
    console.log(`| ${q.name} | ${f(mean(d))} / ${f(pct(d, 0.95))} | ${f(mean(d) - q.rtt / 2)} | ${p(agg(rs, 'stallRate'))} | ${p(agg(rs, 'lateRate'))} | ${p(agg(rs, 'cappedRate'))} |`);
  }
}

console.log('\n## C. Delayed sealing: resimulation load per late input, reliable ordered socket\n');
console.log(`Tick cost ${tickCosts.map(c => `${c} ms`).join(' / ')} (docs/42.22 at 12x6 / 24x12 / 36x18); budget ${f(TICK)} ms per tick.`);
console.log(`Load = (1 + resimulated ticks) x tick cost on a tick where any of ${players} clients' late inputs forces a resimulation.\n`);
console.log(`| profile | window | late (resim) | dropped past window | ticks with a resim | mean resim ticks | p99 resim ticks | ${tickCosts.map(c => `ticks over budget @${c} ms`).join(' | ')} |`);
console.log(`| --- | --- | --- | --- | --- | --- | --- | ${tickCosts.map(() => '---').join(' | ')} |`);
for (const profile of profiles) for (const window of [2, 4, 8]) {
  const rs = Array.from({ length: players }, (_, i) => policyC(link(profile, 'ws', rng(seed + i * 7919 + profile.rtt)), window));
  const merged = Array.from({ length: TICKS }, (_, n) => Math.max(...rs.map(r => r.resim[n]))).slice(WARMUP);
  const hit = merged.filter(x => x > 0);
  console.log(`| ${profile.name} | ${window} (${window * TICK} ms) | ${p(agg(rs, 'lateRate'))} | ${p(agg(rs, 'droppedRate'))} | ${p(hit.length / merged.length)} | ${f(mean(hit), 2)} | ${pct(hit, 0.99)} | ${tickCosts.map(c => p(merged.filter(x => (1 + x) * c > TICK).length / merged.length)).join(' | ')} |`);
}
