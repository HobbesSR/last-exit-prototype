// #1095 (24.5 stage 3): the split delivery under real loss. Chrome plays a match on a generated map through the Rust
// edge, with a lossy UDP relay (tests/helpers/lossy-relay.js) between Chrome and the edge on each of 42.48's
// profiles. 42.56 measured the transport with synthetic frames; this run measures our own: the edge's fragments,
// the page's reassembly and acknowledgements, deltas against acknowledged baselines and whole-frame recovery.
//
// Per run, the server side records every fast datagram the player's session sends: its tick, its size, and
// whether it went as a delta (the session's acknowledged frame was in its history, as `deliverSplit` decides).
// The page notes each message Chrome hands it whole, by the edge's message number, and whether it drew it. Of the
// messages sent within the run, `received` arrived whole and `drawn` were drawn: fewer when a frame arrives after a
// newer one, which the reader ignores. Every count is over the same messages, so drawn never exceeds received.
// The page samples, every 10 ms,
// the tick of the newest frame it has drawn (`arenaDebug().buffer.newest`), and staleness is that sample's time less
// the time the server sent that tick. Both clocks are the machine's (performance.timeOrigin + performance.now()), as
// in 42.56. Staleness includes the up-to-50 ms gap between ticks. Each run also notes how its WebTransport sessions
// ended, as the page saw it: a session closed mid-run is the measurement's failure, not a lost frame.
//
// Usage: node tools/perf/fast-loss-1095.mjs [--profiles=lan,typical,poor] [--seconds=20] [--runs=1] [--seed=1095]
//        [--map-seed=4217] [--ordered] [--out=FILE]
// Needs the Rust toolchain: the edge is built in release first. Takes the bench lock.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { collectBrowserErrors, serveWithBrowser } from '../../tests/helpers/browser.js';
import { chooseProfiles, NETWORK_PROFILES } from '../../tests/helpers/network-profiles.js';
import { startLossyRelay } from '../../tests/helpers/lossy-relay.js';
import { DATAGRAM_PAYLOAD_BYTES } from '../../shared/fast-state.ts';

const args = cliArgs();
const seconds = Number(args.get('seconds') ?? 20), runs = Number(args.get('runs') ?? 1);
const seed = Number(args.get('seed') ?? 1095), mapSeed = Number(args.get('map-seed') ?? 4217), TICK = 50;
// `--ordered` keeps each direction in order (tests/helpers/lossy-relay.js), a nearer stand-in for a real path.
const ordered = args.has('ordered');
const chosen = chooseProfiles(args.get('profiles')).map(p => ordered ? { ...p, ordered } : p);
const now = () => performance.timeOrigin + performance.now();

const stats = list => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b), at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const r = n => Math.round(n * 10) / 10;
  return { n: list.length, p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(sorted.at(-1)) };
};
const percent = (part, whole) => whole ? Math.round(1000 * part / whole) / 10 : null;

const RUST = path.resolve('rust');
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'last-exit-edge'], { cwd: RUST, stdio: 'inherit' });
const binary = path.join(RUST, 'target', 'release', process.platform === 'win32' ? 'last-exit-edge.exe' : 'last-exit-edge');

async function run(profile, runIndex, { server, base, browser }, offer) {
  const relay = await startLossyRelay({ target: offer.port, profile, seed: seed ^ (runIndex * 0x9E3779B1) ^ NETWORK_PROFILES.findIndex(p => p.name === profile.name) * 0x85EBCA6B, tick: TICK });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  collectBrowserErrors(page, errors, { consoleErrors: true });
  // The page discovers the edge from /api/transport: point it at the relay instead.
  await page.route('**/api/transport', async route => {
    const response = await route.fetch(), transport = await response.json();
    transport.webTransport = { ...transport.webTransport, port: relay.port };
    await route.fulfill({ response, json: transport });
  });
  // How each WebTransport session ended, and when, as the page saw it.
  await page.addInitScript(() => {
    const Native = window.WebTransport, ended = window.__sessionsEnded = [];
    if (!Native) return;
    window.WebTransport = class extends Native {
      constructor(...a) {
        super(...a);
        // Every message Chrome hands the page whole, by the edge's message number, and whether it was drawn. The
        // page dispatches a completed message before it reads again, so a draw (a `net.stateBytes` sample, which
        // `?profile` records) between the read that completed it and the next read is that message's.
        const readable = this.datagrams.readable, getReader = readable.getReader.bind(readable), arrived = window.__arrived = new Map();
        const drawnCalls = () => window.arenaProfile?.().series.find(row => row.name === 'net.stateBytes')?.calls ?? 0;
        readable.getReader = (...r) => {
          const reader = getReader(...r), read = reader.read.bind(reader);
          let completed = null, before = 0;
          reader.read = async () => {
            if (completed && drawnCalls() > before) completed.drawn = true;
            completed = null;
            const result = await read(), value = result.value;
            if (value?.length >= 4) {
              const number = (value[0] << 8) | value[1], index = value[2], count = value[3];
              let message = arrived.get(number);
              if (message?.count !== count) arrived.set(number, message = { count, parts: new Set(), drawn: false });
              message.parts.add(index);
              if (message.parts.size === count && !message.whole) { message.whole = true; completed = message; before = drawnCalls(); }
            }
            return result;
          };
          return reader;
        };
        const opened = performance.timeOrigin + performance.now();
        this.closed.then(info => ended.push({ opened, at: performance.timeOrigin + performance.now(), code: info?.closeCode ?? null, reason: info?.reason ?? '' }),
          error => ended.push({ opened, at: performance.timeOrigin + performance.now(), error: String(error) }));
      }
    };
  });
  // The edge numbers a session's messages from 0 in the order Node sends them, counting every SEND frame. Once no
  // other session is being sent any (the last run's has closed), this one's numbers are its sends since now.
  let sendsBefore = server.edgeLink.counts().sends;
  for (let quiet = 0; quiet < 3;) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const linked = server.edgeLink.counts().sends;
    quiet = linked === sendsBefore ? quiet + 1 : 0; sendsBefore = linked;
  }
  const joinStarted = now();
  try {
    await page.goto(`${base}/?seed=${mapSeed}&transport=wt&profile`);
    const start = page.getByRole('button', { name: 'Start match', exact: true });
    await start.waitFor({ state: 'visible', timeout: 120000 });
    const roomId = new URL(page.url()).searchParams.get('room');
    await start.click();
    await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 180000 });
    const liveMs = Math.round(now() - joinStarted);

    // Every fast datagram of the player's session from here on: when, which tick, how big, and delta or whole.
    const room = server.rooms.get(roomId), client = [...room.clients].find(c => c.playerId);
    const sends = [], sentAt = new Map(), datagram = client.datagram;
    let unnumbered = false;
    client.datagram = bytes => {
      const linked = server.edgeLink.counts().sends, number = (linked - sendsBefore) & 0xffff;
      const delta = client.fastAck !== null && client.fastAck !== undefined && !!client.fastHistory?.get(client.fastAck);
      const tick = room.match.tick, at = now();
      // How many ticks behind the send the session's newest acknowledgement is (null before any).
      const ackAge = client.fastAck === null || client.fastAck === undefined ? null : tick - client.fastAck;
      sends.push({ at, tick, bytes: bytes.length, delta, ackAge, number });
      if (!sentAt.has(tick)) sentAt.set(tick, at);
      const sent = datagram(bytes);
      // Another session's send in between would shift the numbers: the run then reports no delivery counts.
      if (sent && server.edgeLink.counts().sends !== linked + 1) unnumbered = true;
      return sent;
    };
    const counts = (rows, name) => rows.find(r => r.name === name)?.calls ?? 0;
    const serverBefore = server.profiler.report(), relayBefore = await relay.counts(), linkBefore = server.edgeLink.counts();

    // Walk back and forth so the frames change as a played match's do, while the page samples what it holds.
    let walking = true;
    const walk = (async () => { for (let i = 0; walking; i++) {
      const key = i % 2 ? 'KeyA' : 'KeyD';
      await page.keyboard.down(key); await page.waitForTimeout(700); await page.keyboard.up(key);
    } })().catch(() => {});
    const samples = await page.evaluate(duration => new Promise(resolve => {
      const out = [], at = () => performance.timeOrigin + performance.now(), end = at() + duration;
      const timer = setInterval(() => {
        const debug = window.arenaDebug();
        out.push([at(), debug.buffer?.newest ?? null, debug.phase]);
        if (at() >= end || debug.phase !== 'live') { clearInterval(timer); resolve(out); }
      }, 10);
    }), seconds * 1000);
    walking = false; await walk;
    const serverAfter = server.profiler.report(), relayAfter = await relay.counts(), linkAfter = server.edgeLink.counts();
    // Messages sent in the run may still be in flight: wait out poor's tail before reading what arrived.
    await page.waitForTimeout(1500);
    client.datagram = datagram;
    // Whether the session measured lasted the run: a page that lost its session resumes on a new one.
    const sessionKept = room.clients.has(client), playerSessions = [...room.clients].filter(c => c.playerId).length;
    // The run is the page's sampling window; every count below is of the messages the server sent within it.
    const from = samples[0][0], to = samples.at(-1)[0], inRun = sends.filter(s => s.at >= from && s.at <= to);
    // Sends, whole frames among them, and the oldest acknowledgement behind a send, per second of the run.
    const perSecond = [], wholePerSecond = [], ackAgePerSecond = [];
    for (const { at, delta, ackAge } of inRun) {
      const i = Math.floor((at - from) / 1000);
      perSecond[i] = (perSecond[i] ?? 0) + 1;
      if (!delta) wholePerSecond[i] = (wholePerSecond[i] ?? 0) + 1;
      if (ackAge !== null) ackAgePerSecond[i] = Math.max(ackAgePerSecond[i] ?? 0, ackAge);
    }
    // A player eliminated before the run draws a spectator's frames of its own view: small deltas, not a mover's.
    const playerStatus = await page.evaluate(() => window.arenaDebug().me?.status ?? null);
    // Of the messages sent in the run, those that reached the page whole, and those it drew, by message number.
    const arrived = new Map(await page.evaluate(() => [...(window.__arrived ?? new Map())].filter(([, m]) => m.whole).map(([n, m]) => [n, m.drawn])));
    const received = unnumbered ? null : inRun.filter(s => arrived.has(s.number)).length;
    const drawn = unnumbered ? null : inRun.filter(s => arrived.get(s.number)).length;
    const sessionsEnded = await page.evaluate(start => (window.__sessionsEnded ?? []).map(e => ({ ...e, opened: Math.round(e.opened - start), at: Math.round(e.at - start) })), samples[0][0]);
    const staleness = [];
    for (const [at, tick] of samples) if (sentAt.has(tick)) staleness.push(at - sentAt.get(tick));
    const kinds = { whole: inRun.filter(s => !s.delta), delta: inRun.filter(s => s.delta) };
    const fragments = bytes => Math.ceil(bytes / DATAGRAM_PAYLOAD_BYTES);
    const serverCount = name => counts(serverAfter, name) - counts(serverBefore, name);
    // The longest run of ticks the page drew nothing new, from its samples.
    let longest = 0, since = null, newest = null;
    for (const [at, tick] of samples) {
      if (tick !== newest) { newest = tick; since = at; } else if (since !== null) longest = Math.max(longest, at - since);
    }
    return {
      profile: profile.name, run: runIndex, seconds: Math.round((samples.at(-1)[0] - samples[0][0]) / 100) / 10,
      endedLive: samples.at(-1)[2] === 'live', joinToLiveMs: liveMs,
      sent: inRun.length, received, receivedPercent: percent(received, inRun.length), drawn, drawnPercent: percent(drawn, inRun.length),
      ackAge: { whole: stats(kinds.whole.filter(s => s.ackAge !== null).map(s => s.ackAge)), delta: stats(kinds.delta.map(s => s.ackAge)), wholeWithoutAck: kinds.whole.filter(s => s.ackAge === null).length },
      whole: { count: kinds.whole.length, bytes: stats(kinds.whole.map(s => s.bytes)), fragments: stats(kinds.whole.map(s => fragments(s.bytes))) },
      delta: { count: kinds.delta.length, percent: percent(kinds.delta.length, inRun.length), bytes: stats(kinds.delta.map(s => s.bytes)), fragments: stats(kinds.delta.map(s => fragments(s.bytes))) },
      streamed: serverCount('loop.fastStreamed'), sessionKept, playerSessions, sendsPerSecond: Array.from(perSecond, n => n ?? 0), wholePerSecond: Array.from({ length: perSecond.length }, (_, i) => wholePerSecond[i] ?? 0),
      ackAgePerSecond: Array.from({ length: perSecond.length }, (_, i) => ackAgePerSecond[i] ?? null), playerStatus, sessionsEnded,
      acknowledgements: linkAfter.acks - linkBefore.acks, inputDatagrams: linkAfter.datagrams - linkBefore.datagrams,
      staleness: stats(staleness), longestStallMs: Math.round(longest),
      relay: Object.fromEntries(Object.keys(relayAfter).map(k => [k, relayAfter[k] - relayBefore[k]])),
      errors,
    };
  } finally {
    await page.close();
    await relay.stop();
  }
}

const lock = await acquireMachineLock('bench');
const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-fast-loss-'));
const session = await serveWithBrowser({ profile: true, profileSummary: false, roomThreads: false, edgeLink: 0, edge: false, replayDir });
const edge = spawn(binary, ['--link', `127.0.0.1:${session.server.edgeLink.port}`, '--port', '0', '--ws-port', '0'], { stdio: ['ignore', 'ignore', 'inherit'] });
const results = [], browserVersion = session.browser.version();
try {
  let offer = null;
  for (let i = 0; i < 100 && !offer; i++) {
    offer = (await (await fetch(`${session.base}/api/client-config`)).json()).webTransport;
    if (!offer) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!offer) throw new Error('The edge never linked.');
  for (const profile of chosen) for (let i = 0; i < runs; i++) {
    const r = await run(profile, i, session, offer);
    results.push(r);
    console.log(`${profile.name}#${i}: received ${r.receivedPercent}% drawn ${r.drawn}/${r.sent} (${r.drawnPercent}%) | delta ${r.delta.percent}% | whole p50 ${r.whole.bytes?.p50} B | stale ${r.staleness?.p50}/${r.staleness?.p95}/${r.staleness?.p99} ms | stall ${r.longestStallMs} ms | streamed ${r.streamed} | errors ${r.errors.length}`);
  }
} finally {
  edge.kill();
  try { await session.close(); } finally { await rm(replayDir, { recursive: true, force: true }); await lock.release(); }
}
const record = { issue: 1095, tool: 'tools/perf/fast-loss-1095.mjs', date: new Date().toISOString(), node: process.version,
  browser: browserVersion, settings: { seconds, runs, seed, mapSeed, tickMs: TICK, fragmentBytes: DATAGRAM_PAYLOAD_BYTES, profiles: chosen }, results };
if (args.get('out')) await writeFile(args.get('out'), JSON.stringify(record, null, 1) + '\n');
setTimeout(() => process.exit(0), 200);
