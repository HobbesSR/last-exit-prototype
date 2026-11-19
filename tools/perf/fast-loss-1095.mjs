// #1095 (24.5 stage 3): the split delivery under real loss. Chrome plays a match on a generated map through the Rust
// edge, with a lossy UDP relay (tests/helpers/lossy-relay.js) between Chrome and the edge on each of 42.48's
// profiles. 42.56 measured the transport with synthetic frames; this run measures our own: the edge's fragments,
// the page's reassembly and acknowledgements, deltas against acknowledged baselines and whole-frame recovery.
//
// Per run, the server side records every fast datagram the player's session sends: its tick, its size, and
// whether it went as a delta (the session's acknowledged frame was in its history, as `deliverSplit` decides).
// The page samples, every 10 ms, the tick of the newest frame it has drawn (`arenaDebug().buffer.newest`), and
// staleness is that sample's time less the time the server sent that tick. Both clocks are the machine's
// (performance.timeOrigin + performance.now()), as in 42.56. Staleness includes the up-to-50 ms gap between ticks.
//
// Usage: node tools/perf/fast-loss-1095.mjs [--profiles=lan,typical,poor] [--seconds=20] [--runs=1] [--seed=1095]
//        [--map-seed=4217] [--out=FILE]
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
  // The page learns the edge from the client config: point it at the relay instead.
  await page.route('**/api/client-config', async route => {
    const response = await route.fetch(), config = await response.json();
    config.webTransport = { ...config.webTransport, port: relay.port };
    await route.fulfill({ response, json: config });
  });
  // How each WebTransport session ended, and when, as the page saw it.
  await page.addInitScript(() => {
    const Native = window.WebTransport, ended = window.__sessionsEnded = [];
    if (!Native) return;
    window.WebTransport = class extends Native {
      constructor(...a) {
        super(...a);
        const opened = performance.timeOrigin + performance.now();
        this.closed.then(info => ended.push({ opened, at: performance.timeOrigin + performance.now(), code: info?.closeCode ?? null, reason: info?.reason ?? '' }),
          error => ended.push({ opened, at: performance.timeOrigin + performance.now(), error: String(error) }));
      }
    };
  });
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
    client.datagram = bytes => {
      const delta = client.fastAck !== null && client.fastAck !== undefined && !!client.fastHistory?.get(client.fastAck);
      const tick = room.match.tick, at = now();
      sends.push({ at, tick, bytes: bytes.length, delta });
      if (!sentAt.has(tick)) sentAt.set(tick, at);
      return datagram(bytes);
    };
    const counts = (rows, name) => rows.find(r => r.name === name)?.calls ?? 0;
    const serverBefore = server.profiler.report(), relayBefore = await relay.counts(), linkBefore = server.edgeLink.counts();
    const drawnBefore = counts((await page.evaluate(() => window.arenaProfile())).series, 'net.stateBytes');

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
    client.datagram = datagram;
    // Whether the session measured lasted the run: a page that lost its session resumes on a new one.
    const sessionKept = room.clients.has(client), playerSessions = [...room.clients].filter(c => c.playerId).length;
    const perSecond = [];
    for (const { at } of sends) { const i = Math.floor((at - samples[0][0]) / 1000); if (i >= 0) perSecond[i] = (perSecond[i] ?? 0) + 1; }
    const transport = await page.evaluate(start => (window.__sessionsEnded ?? []).map(e => ({ ...e, opened: Math.round(e.opened - start), at: Math.round(e.at - start) })), samples[0][0]);

    const serverAfter = server.profiler.report(), relayAfter = await relay.counts(), linkAfter = server.edgeLink.counts();
    const drawn = counts((await page.evaluate(() => window.arenaProfile())).series, 'net.stateBytes') - drawnBefore;
    const staleness = [];
    for (const [at, tick] of samples) if (sentAt.has(tick)) staleness.push(at - sentAt.get(tick));
    const kinds = { whole: sends.filter(s => !s.delta), delta: sends.filter(s => s.delta) };
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
      sent: sends.length, drawn, drawnPercent: percent(drawn, sends.length),
      whole: { count: kinds.whole.length, bytes: stats(kinds.whole.map(s => s.bytes)), fragments: stats(kinds.whole.map(s => fragments(s.bytes))) },
      delta: { count: kinds.delta.length, percent: percent(kinds.delta.length, sends.length), bytes: stats(kinds.delta.map(s => s.bytes)), fragments: stats(kinds.delta.map(s => fragments(s.bytes))) },
      streamed: serverCount('loop.fastStreamed'), sessionKept, playerSessions, sendsPerSecond: Array.from(perSecond, n => n ?? 0), page: transport,
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
const session = await serveWithBrowser({ profile: true, profileSummary: false, roomThreads: false, edgeLink: 0, replayDir });
const edge = spawn(binary, ['--link', `127.0.0.1:${session.server.edgeLink.port}`, '--port', '0'], { stdio: ['ignore', 'ignore', 'inherit'] });
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
    console.log(`${profile.name}#${i}: drawn ${r.drawn}/${r.sent} (${r.drawnPercent}%) | delta ${r.delta.percent}% | whole p50 ${r.whole.bytes?.p50} B | stale ${r.staleness?.p50}/${r.staleness?.p95}/${r.staleness?.p99} ms | stall ${r.longestStallMs} ms | streamed ${r.streamed} | errors ${r.errors.length}`);
  }
} finally {
  edge.kill();
  try { await session.close(); } finally { await rm(replayDir, { recursive: true, force: true }); await lock.release(); }
}
const record = { issue: 1095, tool: 'tools/perf/fast-loss-1095.mjs', date: new Date().toISOString(), node: process.version,
  browser: browserVersion, settings: { seconds, runs, seed, mapSeed, tickMs: TICK, fragmentBytes: DATAGRAM_PAYLOAD_BYTES, profiles: chosen }, results };
if (args.get('out')) await writeFile(args.get('out'), JSON.stringify(record, null, 1) + '\n');
setTimeout(() => process.exit(0), 200);
