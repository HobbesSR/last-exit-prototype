// #1094 delta design witness, isolated from the live protocol. Captures every player view and the dev view of a
// real match through the production projection and broadcast, then replays them offline over simulated channels:
//   R   today: keyframe layers plus the whole per-tick part over one reliable ordered stream (real broadcast payloads)
//   A   every frame over datagrams as a delta against the newest frame the client acknowledged (whole when none)
//   S   split: items, gates and own discovery on a reliable stream with today's layers; the rest as A
//   Aq, Sq  the same with 24.1's candidate quanta applied before comparison
// Bytes use 42.47's dictionary prototype as a codec-agnostic meter, plus JSON. Scope and budgets: #1094 comment 15355.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { deserialize, getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createMatch } from '../../server/match.js';
import { broadcast, remember, viewEncoders } from '../../server/room-views.js';
import { createLayerEncoder } from '../../shared/frame-layers.ts';
import { createDiscoveryEncoder } from '../../shared/discovery.ts';
import { liveZoneSize } from '../../map/live.ts';
import { contentById, CONTENT_ID } from '../../shared/simulation/content.ts';
import { attachPortalGraph } from '../../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../../shared/free-space.ts';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { collectKeys, createCodec } from './wire-codec-prototype.mjs';
import { encodeDelta, applyDelta, quantizeFrame, predictionDependency, ENVELOPE_KEYS } from './wire-1094-delta-format.mjs';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');
const args = cliArgs(), ticks = Number(args.get('ticks') ?? 1200), seed = Number(args.get('seed') ?? 1094);
const HISTORY = Number(args.get('history') ?? 32), CAP = 1200, FRAGMENT_HEADER = 4, SEGMENT = 1448, WARMUP = 40, TICK_MS = 50;
const SHARED_SOCKETS = 16;
if (!args.has('maps-cache') || !args.has('out')) throw new Error('--maps-cache and --out required');
const timing = args.has('timing');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });
const hash = data => createHash('sha256').update(data).digest('hex');
const DECLARATION_EXPORTS = ['shared/simulation/projection-contract.ts', 'shared/simulation/visibility.ts'];

// 42.48's profiles unchanged (rtt ms, mean exponential jitter ms, independent loss), plus one bursty profile:
// Gilbert-Elliott over 50 ms send slots, 3% of slots lost with a mean outage of 4 slots, at typical's rtt and jitter.
const PROFILES = [
  { name: 'lan', rtt: 4, jitter: 1, loss: 0 },
  { name: 'good', rtt: 40, jitter: 4, loss: 0.002 },
  { name: 'typical', rtt: 80, jitter: 12, loss: 0.01 },
  { name: 'wifi', rtt: 120, jitter: 35, loss: 0.03 },
  { name: 'poor', rtt: 220, jitter: 70, loss: 0.05 },
  { name: 'bursty', rtt: 80, jitter: 12, loss: 0.03, burst: 4 },
];
function rng(s) { let a = s >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seedOf = (...parts) => parseInt(hash(parts.join('|')).slice(0, 8), 16) ^ seed;
// A counter-based draw: one number per (stream, slot, packet, purpose), whatever else was drawn, so every candidate
// meets the same network (review 863 on PR #1137: a shared sequential stream drifted with fragment counts).
function draw(stream, n) {
  let x = (stream ^ Math.imul(n, 0x9E3779B1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85EBCA6B) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xC2B2AE35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
/**
 * One direction of one connection as a fixed trace. A slot is a 50 ms send time (a tick downstream, an input
 * upstream); `packet` numbers the packets sent in that slot (fragments, segments). Bursty loss is a property of
 * the slot: an outage loses every packet sent during it.
 */
function channel(profile, ...key) {
  const stream = seedOf(profile.name, ...key), at = (slot, packet, purpose) => draw(stream, ((slot * 256 + packet) * 4 + purpose) >>> 0);
  const stay = profile.burst ? 1 - 1 / profile.burst : 0, enter = profile.burst ? profile.loss * (1 - stay) / (1 - profile.loss) : 0;
  const outage = [];
  const bad = slot => { for (let i = outage.length; i <= slot; i++) outage.push((i && outage[i - 1]) ? at(i, 0, 3) < stay : at(i, 0, 3) < enter); return outage[slot]; };
  return {
    lost: (slot, packet) => { assert.ok(packet < 256, 'packet index within a slot'); return profile.burst ? bad(slot) : at(slot, packet, 0) < profile.loss; },
    delay: (slot, packet) => profile.rtt / 2 - profile.jitter * Math.log(1 - at(slot, packet, 1)),
    stall: () => Math.max(200, profile.rtt * 1.5),
  };
}

const stats = list => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { n: list.length, mean: round(list.reduce((a, b) => a + b, 0) / list.length), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) };
};
const round = n => Math.round(n * 100) / 100;
const share = (list, test) => list.length ? round(100 * list.filter(test).length / list.length) : null;

const lock = await acquireMachineLock('bench', { mode: timing ? 'exclusive' : 'shared' });
let match;
try {
  const bytes = await readFile(args.get('maps-cache')), cache = deserialize(bytes);
  const [zoneWidth, zoneHeight] = cache.size.split('x').map(Number), size = liveZoneSize({ zoneWidth, zoneHeight });
  if (!size || !cache.maps?.length || cache.content !== CONTENT_ID || cache.generator !== 'chain-live-2' || !cache.source) throw new Error('requires a tuned chain-live-2 cache with a source revision (42.47)');
  execFileSync('git', ['diff', '--exit-code', cache.source, '--', 'map', 'shared', 'server', ...DECLARATION_EXPORTS.map(p => `:!${p}`)]);
  const entry = structuredClone(cache.maps[0]);
  if (entry.navigation) attachPortalGraph(entry.map, entry.navigation);
  for (const packed of entry.tiles ?? []) adoptPackedTiles(entry.map, packed);
  match = await createMatch(cache.seed, size, entry.map, contentById(cache.content));

  // ---- Capture: every player's own view and dev, each tick, plus today's real payloads ----------------
  const roster = match.snapshot().players, views = [...roster.map(p => p.id), 'dev'];
  const role = Object.fromEntries([...roster.map(p => [p.id, p.role]), ['dev', 'dev']]);
  const frames = Object.fromEntries(views.map(v => [v, []])), today = Object.fromEntries(views.map(v => [v, []]));
  const room = { match, clients: new Set(), history: [], ...viewEncoders() };
  for (const view of views) room.clients.add({ playerId: view === 'dev' ? undefined : view, dev: view === 'dev', deliver(payload) { today[view].push(payload); return true; } });
  // S's reliable stream: today's layer and discovery encoders for one always-delivered session per player view.
  const slow = Object.fromEntries(views.filter(v => v !== 'dev').map(v => [v, { layers: createLayerEncoder(), discovery: createDiscoveryEncoder(), held: {}, messages: [] }]));
  let current;
  for (let at = 0; at <= ticks; at++) {
    current = at ? match.advance() : match.snapshot();
    remember(room, current);
    broadcast(room, current);
    for (const view of views) {
      const frame = match.project(current, view === 'dev' ? undefined : view);
      frames[view].push(frame);
      if (view === 'dev') continue;
      const s = slow[view], encoded = s.layers.encode({ items: frame.items, gates: frame.gates }), message = {};
      const me = frame.players.find(p => p.id === view);
      if (me?.discovered) encoded.discovered = s.discovery.encode(me.discovered);
      for (const [layer, e] of Object.entries(encoded)) {
        if ('plain' in e) { message[layer] = e.plain; continue; }
        const whole = s.held[layer] !== e.k, wire = whole ? e.all() : e.changes;
        if (whole || wire.set || wire.drop) message[layer] = wire;
        s.held[layer] = e.k;
      }
      if (Object.keys(message).length) s.messages.push({ tick: frame.tick, message });
    }
    if (match.phase !== 'live') break;
  }
  const lastIndex = frames[views[0]].length - 1;
  for (const view of views) assert.equal(today[view].length, lastIndex + 1, `${view}: one real payload per tick`);

  // ---- Meter: 42.47's dictionary prototype, its dictionary drawn from the whole capture -----------------
  const keys = new Set(ENVELOPE_KEYS);
  for (const view of views) for (const payload of today[view]) collectKeys(JSON.parse(payload), keys);
  let codec = createCodec([...keys].sort());
  const meter = value => {
    try { return codec.encode(value).length; }
    catch (error) { if (!/Unknown key/.test(error.message)) throw error; collectKeys(value, keys); codec = createCodec([...keys].sort()); return codec.encode(value).length; }
  };
  const jsonBytes = value => Buffer.byteLength(JSON.stringify(value));
  const normal = value => JSON.parse(JSON.stringify(value));

  // ---- Frames per candidate, and their messages ---------------------------------------------------------
  // S's datagram part leaves out what its reliable stream carries.
  const fast = frame => ({ ...frame, items: undefined, gates: undefined, players: frame.players.map(p => p.discovered ? { ...p, discovered: undefined } : p) });
  const forms = {
    A: (view, i) => frames[view][i],
    S: (view, i) => fastCache(view, i, 'S', () => fast(frames[view][i])),
    Aq: (view, i) => fastCache(view, i, 'Aq', () => quantizeFrame(frames[view][i])),
    Sq: (view, i) => fastCache(view, i, 'Sq', () => quantizeFrame(forms.S(view, i))),
    // Quantized except what prediction collides with: own state and every possible proxy stay exact (review 863).
    Sp: (view, i) => fastCache(view, i, 'Sp', () => quantizeFrame(forms.S(view, i), predictionDependency(view))),
  };
  const formCache = new Map();
  function fastCache(view, i, form, make) {
    const key = `${form}|${view}|${i}`;
    let value = formCache.get(key);
    if (!value) formCache.set(key, value = make());
    return value;
  }
  const messageCache = new Map(); let verified = 0;
  function message(form, view, b, t) {
    const key = `${form}|${view}|${b}|${t}`;
    let m = messageCache.get(key);
    if (m) return m;
    const base = b >= 0 ? forms[form](view, b) : null, frame = forms[form](view, t);
    const delta = encodeDelta(base, frame, { t, b });
    // Every distinct message is decoded and compared with the frame as JSON would carry it.
    if (role[view] !== 'dev' || t % 20 === 0) { assert.deepStrictEqual(normal(applyDelta(base && normal(base), normal(delta))), normal(frame), `${form} ${view} ${b}->${t}`); verified++; }
    messageCache.set(key, m = { meter: meter(delta), json: jsonBytes(delta), whole: b < 0 });
    return m;
  }

  // ---- Channels ----------------------------------------------------------------------------------------
  const fragments = bytes => bytes <= CAP ? 1 : Math.ceil(bytes / (CAP - FRAGMENT_HEADER));
  /**
   * A reliable ordered stream: a lost segment stalls its message and everything behind it. It reads the socket's
   * downstream trace, so today's stream and the datagrams meet the same losses; `first` offsets its packet numbers
   * when it shares a slot with another stream of the same connection (S's reliable half).
   */
  function reliable(profile, key, sends, first = 0) {
    const ch = channel(profile, key, 'down'); let last = -Infinity;
    return sends.map(({ at, bytes }) => {
      const slot = Math.round(at / TICK_MS);
      let arrival = at + ch.delay(slot, first);
      for (let s = 0; s < Math.ceil(bytes / SEGMENT); s++) if (ch.lost(slot, first + s)) { arrival += ch.stall(); break; }
      return last = Math.max(arrival, last + 0.001);
    });
  }
  /** Datagrams with acknowledged baselines. Acks ride the client's 20 Hz input packets upstream. */
  function datagrams(profile, form, view, key = view) {
    // The socket's fixed traces: every candidate meets the same losses and delays (channel above).
    const down = channel(profile, key, 'down'), up = channel(profile, key, 'up');
    const phase = rng(seedOf('phase', key))() * TICK_MS, received = [], pending = [], rows = [];
    let upIndex = 0, serverAck = -1, clientNewest = -1;
    const upstream = [];
    for (let t = 0; t <= lastIndex; t++) {
      const now = t * TICK_MS;
      // Client input packets sent before now: each acknowledges the newest frame the client then held.
      for (let sendAt = phase + upIndex * TICK_MS; sendAt <= now; sendAt = phase + ++upIndex * TICK_MS) {
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].arrival <= sendAt) { clientNewest = Math.max(clientNewest, pending[i].t); pending.splice(i, 1); }
        if (clientNewest >= 0 && !up.lost(upIndex, 0)) upstream.push({ arrival: sendAt + up.delay(upIndex, 0), ack: clientNewest });
      }
      for (let i = upstream.length - 1; i >= 0; i--) if (upstream[i].arrival <= now) { serverAck = Math.max(serverAck, upstream[i].ack); upstream.splice(i, 1); }
      const b = serverAck >= 0 && t - serverAck <= HISTORY ? serverAck : -1;
      const m = message(form, view, b, t), n = fragments(m.meter);
      let arrival = -Infinity;
      for (let f = 0; f < n; f++) { if (down.lost(t, f)) arrival = Infinity; else arrival = Math.max(arrival, now + down.delay(t, f)); }
      rows.push({ t, b, ...m, n, arrival });
      if (arrival < Infinity) { pending.push({ t, arrival }); received.push({ t, arrival }); }
    }
    return { rows, received };
  }
  /** Age of the newest complete frame at each tick boundary (49 ms after the tick is sent), and when the first lands. */
  function staleness(received) {
    const sorted = [...received].sort((a, b) => a.arrival - b.arrival), ages = [], newestByTick = [];
    let j = 0, newest = -1;
    for (let t = 0; t <= lastIndex; t++) {
      const T = t * TICK_MS + 49;
      while (j < sorted.length && sorted[j].arrival <= T) newest = Math.max(newest, sorted[j++].t);
      newestByTick.push(newest);
      if (t >= WARMUP) ages.push(newest < 0 ? Infinity : T - newest * TICK_MS);
    }
    return { ages, first: sorted.length ? sorted[0].arrival : Infinity, newestByTick };
  }

  // ---- Simulation --------------------------------------------------------------------------------------
  const playerViews = views.filter(v => v !== 'dev'), results = {};
  const itemIds = new Map();
  const idsAt = (view, i) => { const key = `${view}|${i}`; let ids = itemIds.get(key); if (!ids) itemIds.set(key, ids = new Set(frames[view][i].items.map(item => String(item.id)))); return ids; };
  for (const profile of PROFILES) {
    const byRole = {};
    const bucket = (r, name) => ((byRole[r] ||= {})[name] ||= { bytes: [], json: [], reliable: [], firstMessage: [], eventsTotal: 0, eventsMissed: 0, ages: [], baselineAge: [], fragmented: [], whole: [], first: [], slowLag: [], orphans: [], orphanTicks: [] });
    for (const view of playerViews) {
      // R: today's payloads, every tick, over one reliable stream.
      const sizes = today[view].map(p => Buffer.byteLength(p)), sends = sizes.map((bytes, t) => ({ at: t * TICK_MS, bytes }));
      const arrivals = reliable(profile, view, sends), r = bucket(role[view], 'R');
      const st = staleness(arrivals.map((arrival, t) => ({ t, arrival })));
      r.ages.push(...st.ages); r.first.push(st.first); r.firstMessage.push({ meter: meterToday(view, 0), json: sizes[0], segments: Math.ceil(sizes[0] / SEGMENT) });
      for (let t = WARMUP; t <= lastIndex; t++) { r.reliable.push(sizes[t]); r.bytes.push(meterToday(view, t)); }
      for (const form of ['A', 'Aq', 'S', 'Sq', 'Sp']) {
        const c = bucket(role[view], form), { rows, received } = datagrams(profile, form, view), st2 = staleness(received);
        c.ages.push(...st2.ages); c.first.push(st2.first); c.firstMessage.push({ meter: rows[0].meter, json: rows[0].json, fragments: rows[0].n });
        // Events are the last six (shared/simulation/loot.ts): one pushed out before any frame holding it arrives is never seen.
        const seen = new Set(received.flatMap(r => (frames[view][r.t].events ?? []).map(e => e.id)));
        const all = new Set(frames[view].flatMap(f => (f.events ?? []).map(e => e.id)));
        c.eventsTotal += all.size; for (const id of all) if (!seen.has(id)) c.eventsMissed++;
        for (const row of rows.slice(WARMUP)) {
          c.bytes.push(row.meter); c.json.push(row.json); c.fragmented.push(row.n > 1); c.whole.push(row.whole);
          if (row.b >= 0) c.baselineAge.push(row.t - row.b);
        }
        if (form[0] === 'S') {
          // Its reliable stream, and whether a body's item is held when that body's frame is.
          const msgs = slow[view].messages, msgBytes = msgs.map(m => meter(m.message));
          const slowArrivals = reliable(profile, view, msgs.map(m => ({ at: m.tick * TICK_MS, bytes: Buffer.byteLength(JSON.stringify(m.message)) })), 128);
          let steadyBytes = 0; msgs.forEach((m, i) => { if (m.tick >= WARMUP) steadyBytes += msgBytes[i]; });
          c.reliable.push(steadyBytes / (lastIndex - WARMUP + 1));
          let j = 0, held = -1;
          for (let t = WARMUP; t <= lastIndex; t++) {
            const T = t * TICK_MS + 49;
            while (j < msgs.length && slowArrivals[j] <= T) j++;
            // Everything up to the tick before the next undelivered message is held.
            held = j < msgs.length ? msgs[j].tick - 1 : lastIndex;
            const shown = st2.newestByTick[t];
            if (shown < 0) continue;
            c.slowLag.push(Math.max(0, shown - held) * TICK_MS);
            const ids = idsAt(view, Math.min(held, shown)), orphaned = (frames[view][shown].bodies ?? []).filter(body => body.itemId !== undefined && !ids.has(String(body.itemId))).length;
            c.orphans.push(orphaned); c.orphanTicks.push(orphaned > 0);
          }
        }
      }
    }
    results[profile.name] = Object.fromEntries(Object.entries(byRole).map(([r, candidates]) => [r, Object.fromEntries(Object.entries(candidates).map(([name, c]) => [name, {
      datagramMeterBytes: name === 'R' ? null : stats(c.bytes), datagramJsonBytes: stats(c.json),
      todayMeterBytes: name === 'R' ? stats(c.bytes) : null,
      reliableBytesPerTick: name === 'R' ? stats(c.reliable) : c.reliable.length ? round(c.reliable.reduce((a, b) => a + b, 0) / c.reliable.length) : null,
      fragmentedPercent: share(c.fragmented, Boolean), wholeFramePercent: share(c.whole, Boolean), baselineAgeTicks: stats(c.baselineAge),
      stalenessMs: stats(c.ages.filter(Number.isFinite)), neverReceivedSamples: c.ages.filter(a => !Number.isFinite(a)).length,
      firstFrameMs: stats(c.first.filter(Number.isFinite)),
      ...(name === 'R' ? {} : { events: { total: c.eventsTotal, missed: c.eventsMissed } }),
      firstMessage: { meter: stats(c.firstMessage.map(m => m.meter)), json: stats(c.firstMessage.map(m => m.json)), fragments: stats(c.firstMessage.map(m => m.fragments ?? m.segments)) },
      ...(c.slowLag.length ? { slowLagMs: stats(c.slowLag), orphanedItemBodyTicksPercent: share(c.orphanTicks, Boolean), orphanedItemBodies: stats(c.orphans) } : {}),
    }]))]));
  }
  function meterToday(view, t) { return meter(JSON.parse(today[view][t])); }

  // ---- Shared view: how many distinct acknowledged baselines 16 sockets on one view hold -------------
  const sharedVariants = {};
  for (const profile of PROFILES) {
    const perTick = new Map();
    for (let s = 0; s < SHARED_SOCKETS; s++) for (const row of datagrams(profile, 'A', 'dev', `dev#${s}`).rows) {
      if (row.t < WARMUP) continue;
      let set = perTick.get(row.t); if (!set) perTick.set(row.t, set = new Set()); set.add(row.b);
    }
    sharedVariants[profile.name] = stats([...perTick.values()].map(set => set.size));
  }

  // ---- CPU (timing only): diff per player view per tick, against today's serialization ----------------
  let cpu = null;
  if (timing) {
    cpu = {};
    const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const time = (fn, n) => { const start = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(i); return Number(process.hrtime.bigint() - start) / 1e3 / n; };
    const pv = playerViews, span = lastIndex - WARMUP;
    const pick = i => ({ view: pv[i % pv.length], t: WARMUP + 3 + (Math.floor(i / pv.length) % (span - 3)) });
    const N = pv.length * (span - 3);
    const quantized = new Map(); // production quantizes each frame once and keeps it as the baseline
    const rounds = { todayStringify: [], diffExact: [], quantizeThenDiff: [], diffExactAge8: [], splitDiffExact: [], splitQuantizeThenDiff: [] };
    const split = new Map(), splitFrame = (view, k) => { const key = `${view}|${k}`; let f = split.get(key); if (!f) split.set(key, f = fast(frames[view][k])); return f; };
    for (let r = 0; r < 3; r++) {
      rounds.todayStringify.push(time(i => { const { view, t } = pick(i); JSON.stringify(JSON.parse(today[view][t])); }, N) - time(i => { const { view, t } = pick(i); JSON.parse(today[view][t]); }, N));
      rounds.diffExact.push(time(i => { const { view, t } = pick(i); encodeDelta(frames[view][t - 3], frames[view][t], { t, b: t - 3 }); }, N));
      rounds.diffExactAge8.push(time(i => { const { view, t } = pick(i); const b = Math.max(0, t - 8); encodeDelta(frames[view][b], frames[view][t], { t, b }); }, N));
      // S's datagram part. Building the split view is outside the timing: production projects it directly.
      for (let i = 0; i < N; i++) { const { view, t } = pick(i); splitFrame(view, t); splitFrame(view, t - 3); }
      rounds.splitDiffExact.push(time(i => { const { view, t } = pick(i); encodeDelta(splitFrame(view, t - 3), splitFrame(view, t), { t, b: t - 3 }); }, N));
      quantized.clear();
      rounds.splitQuantizeThenDiff.push(time(i => {
        const { view, t } = pick(i);
        const q = k => { const key = `${view}|${k}`; let f = quantized.get(key); if (!f) quantized.set(key, f = quantizeFrame(splitFrame(view, k))); return f; };
        encodeDelta(q(t - 3), q(t), { t, b: t - 3 });
      }, N));
      quantized.clear();
      rounds.quantizeThenDiff.push(time(i => {
        const { view, t } = pick(i);
        const q = k => { const key = `${view}|${k}`; let f = quantized.get(key); if (!f) quantized.set(key, f = quantizeFrame(frames[view][k])); return f; };
        encodeDelta(q(t - 3), q(t), { t, b: t - 3 });
      }, N));
    }
    for (const [name, list] of Object.entries(rounds)) cpu[name] = { medianMicrosPerView: round(median(list)), rounds: list.map(round) };
  }

  // ---- History memory: the last N frames per view, marginal heap once nothing else holds them ---------
  // Runs last: the capture and every cache are released first, so only the window keeps frames alive.
  const distinctMessages = messageCache.size;
  formCache.clear(); messageCache.clear(); itemIds.clear();
  const window = views.map(view => frames[view].slice(-HISTORY));
  for (const view of views) frames[view].length = 0;
  const heap = () => { gc(); gc(); return getHeapStatistics().used_heap_size; };
  const memory = { frames: HISTORY, views: views.length, playerViews: playerViews.length };
  let quantizedWindow = window.map(list => list.map(frame => quantizeFrame(frame)));
  let h0 = heap(); quantizedWindow = null; let h1 = heap();
  memory.quantizedCopyBytes = h0 - h1;
  let held = window; h0 = heap(); held.length = 0; held = null; h1 = heap();
  memory.exactWindowBytes = h0 - h1;
  memory.note = 'Marginal used heap of retaining the window, after major GC; frozen item and gate records the live match still holds are shared and not counted';

  const sources = ['tools/perf/wire-1094-deltas.mjs', 'tools/perf/wire-1094-delta-format.mjs', 'tools/perf/wire-codec-prototype.mjs', 'shared/frame-layers.ts', 'shared/keyed-list.ts', 'server/room-views.js'];
  const report = {
    witness: '#1094 acknowledged-baseline delta simulation', date: new Date().toISOString(), revision: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--short').trim().split(/\r?\n/).filter(Boolean),
    sourceHashesLf: Object.fromEntries(await Promise.all(sources.map(async f => [f, hash((await readFile(f, 'utf8')).replace(/\r\n/g, '\n'))]))),
    runtime: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model, lock: lock.mode ?? (timing ? 'exclusive' : 'shared') },
    workload: { cache: args.get('maps-cache'), cacheSha256: hash(bytes), size: cache.size, seed: cache.seed, content: cache.content, source: cache.source, ticks: lastIndex, warmupTicks: WARMUP,
      views: Object.fromEntries(Object.entries(Object.groupBy(views, v => role[v])).map(([r, list]) => [r, list.length])) },
    settings: { historyTicks: HISTORY, datagramCap: CAP, fragmentHeader: FRAGMENT_HEADER, tcpSegment: SEGMENT, profiles: PROFILES, sharedSockets: SHARED_SOCKETS, channelSeed: seed },
    verifiedReconstructions: verified, distinctMessages,
    results, sharedVariants, memory, cpu,
    limitations: [
      'Bytes are 42.47\'s dictionary prototype (per-value tags, float64 for non-integers), a meter for ranking strategies, not the selected codec',
      'Offline replay of bot projections: no human input, no bandwidth or congestion model, symmetric independent paths',
      'Reliable stream: a lost segment stalls max(200, 1.5 rtt) as in 42.48; no TCP window, slow start or retransmission timer backoff',
      'Acknowledgements ride every 20 Hz input packet; client input timing is a fixed phase, not #1096\'s adjusted clock',
    ],
  };
  await writeFile(args.get('out'), `${JSON.stringify(report, null, 1)}\n`);
  const summary = {};
  for (const [p, byRole] of Object.entries(results)) for (const [r, cands] of Object.entries(byRole)) for (const [name, c] of Object.entries(cands))
    summary[`${p} ${r} ${name}`] = { bytes: (c.datagramMeterBytes ?? c.todayMeterBytes)?.mean, p95: (c.datagramMeterBytes ?? c.todayMeterBytes)?.p95, frag: c.fragmentedPercent, whole: c.wholeFramePercent, rel: typeof c.reliableBytesPerTick === 'number' ? c.reliableBytesPerTick : c.reliableBytesPerTick?.mean, staleMean: c.stalenessMs?.mean, staleP95: c.stalenessMs?.p95, staleP99: c.stalenessMs?.p99, lag95: c.slowLagMs?.p95, orphan: c.orphanedItemBodyTicksPercent };
  console.table(summary);
  console.log(JSON.stringify({ verified, sharedVariants, memory, cpu }, null, 1));
} finally { match?.dispose?.(); await lock.release?.(); }
