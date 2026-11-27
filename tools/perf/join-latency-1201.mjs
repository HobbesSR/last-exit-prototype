// #1201: Measure WebTransport join latency under latency/jitter against WebSocket over a TCP delay proxy.
//
// Measures the bytes sent on the reliable stream before `ready` arrives (`welcome`, `lobby`, waiting-yard
// `state` frames, `ready` broken down by field, and any `slow`/`seats` ahead of live), the effective stream
// throughput, edge `WRITTEN` completion vs client receipt on WebTransport, and end-to-end join-to-live time
// across network profiles (`lan`, `typical`, `wifi`, `poor`, `poor-lossless`) for both `--ordered` UDP
// WebTransport and a TCP delay proxy WebSocket baseline.
//
// Usage: node tools/perf/join-latency-1201.mjs [--profiles=lan,typical,wifi,poor,poor-lossless]
//        [--transports=wt,ws] [--runs=3] [--seed=1201] [--map-seed=4217] [--unordered] [--out=FILE]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { acquireMachineLock } from '../../tests/helpers/machine-lock.js';
import { cliArgs } from '../../tests/helpers/args.js';
import { collectBrowserErrors, serveWithBrowser } from '../../tests/helpers/browser.js';
import { chooseProfiles, NETWORK_PROFILES } from '../../tests/helpers/network-profiles.js';
import { startLossyRelay } from '../../tests/helpers/lossy-relay.js';
import { startTcpDelayProxy } from '../../tests/helpers/tcp-delay-proxy.js';
import { FRAME } from '../../server/edge-link.js';

const args = cliArgs();
const runs = Number(args.get('runs') ?? 3);
const seed = Number(args.get('seed') ?? 1201);
const mapSeed = Number(args.get('map-seed') ?? 4217);
const TICK = 50;
const ordered = !args.has('unordered');
const profilesArg = args.get('profiles') ?? 'lan,typical,wifi,poor,poor-lossless';
const chosen = chooseProfiles(profilesArg).map(p => ({ ...p, ordered }));
const transports = (args.get('transports') ?? 'wt,ws').split(',').map(s => s.trim()).filter(Boolean);
const now = () => performance.timeOrigin + performance.now();

const stats = list => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const at = p => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const r = n => Math.round(n * 10) / 10;
  return { n: list.length, min: r(sorted[0]), p50: r(at(0.5)), p95: r(at(0.95)), max: r(sorted.at(-1)) };
};

const GZIP_FORMAT = 0xd2;
const parseCompressedEnvelope = payload => {
  if (payload.length < 3 || payload[0] !== GZIP_FORMAT) return null;
  let at = 1;
  while (at < payload.length && (payload[at++] & 0x80) !== 0) {}
  if (at >= payload.length) return null;
  try {
    return JSON.parse(gunzipSync(payload.subarray(at)).toString('utf8'));
  } catch { return null; }
};

/**
 * Transparent loopback TCP tap between `last-exit-edge` and Node's `edgeLink` server, recording every
 * `DELIVER` and `WRITTEN` frame for the active session without adding delay.
 */
async function startEdgeLinkTap(targetPort) {
  const events = [];
  let active = null;
  const parseFrames = (buf, dir) => {
    while (buf.length >= 5) {
      const length = buf.readUInt32BE(0);
      if (buf.length < 4 + length) break;
      const type = buf[4], body = buf.subarray(5, 4 + length);
      buf = buf.subarray(4 + length);
      const t = now();
      if (dir === 'down' && type === FRAME.DELIVER && body.length >= 5) {
        const sessionId = body.readUInt32BE(0), flag = body[4], payload = body.subarray(5);
        let msgType = flag === 1 ? 'binary' : 'text';
        if (flag === 0) {
          try { msgType = JSON.parse(payload.toString('utf8')).type ?? 'text'; } catch { /* leave as text */ }
        } else {
          msgType = parseCompressedEnvelope(payload)?.type ?? 'binary';
        }
        events.push({ dir, at: t, type: 'DELIVER', sessionId, flag, payloadBytes: payload.length, msgType });
      } else if (dir === 'down' && type === FRAME.SEND && body.length >= 4) {
        events.push({ dir, at: t, type: 'SEND', sessionId: body.readUInt32BE(0), payloadBytes: body.length - 4 });
      } else if (dir === 'up' && type === FRAME.OPEN && body.length === 4) {
        events.push({ dir, at: t, type: 'OPEN', sessionId: body.readUInt32BE(0) });
      } else if (dir === 'up' && type === FRAME.MESSAGE && body.length >= 5) {
        const sessionId = body.readUInt32BE(0), flag = body[4], payload = body.subarray(5);
        let msgType = flag === 1 ? 'binary' : 'text';
        if (flag === 0) {
          try { msgType = JSON.parse(payload.toString('utf8')).type ?? 'text'; } catch { /* leave as text */ }
        }
        events.push({ dir, at: t, type: 'MESSAGE', sessionId, payloadBytes: payload.length, msgType });
      } else if (dir === 'up' && type === FRAME.WRITTEN && body.length === 12) {
        events.push({ dir, at: t, type: 'WRITTEN', sessionId: body.readUInt32BE(0), writtenBytes: Number(body.readBigUInt64BE(4)) });
      } else if (dir === 'up' && type === FRAME.CLOSED && body.length === 4) {
        events.push({ dir, at: t, type: 'CLOSED', sessionId: body.readUInt32BE(0) });
      }
    }
    return buf;
  };
  const server = createServer(edgeSock => {
    edgeSock.setNoDelay(true);
    const nodeSock = connect(targetPort, '127.0.0.1');
    nodeSock.setNoDelay(true);
    active = { edgeSock, nodeSock };
    let up = Buffer.alloc(0), down = Buffer.alloc(0);
    edgeSock.on('data', chunk => {
      up = parseFrames(up.length ? Buffer.concat([up, chunk]) : chunk, 'up');
      if (!nodeSock.destroyed) nodeSock.write(chunk);
    });
    nodeSock.on('data', chunk => {
      down = parseFrames(down.length ? Buffer.concat([down, chunk]) : chunk, 'down');
      if (!edgeSock.destroyed) edgeSock.write(chunk);
    });
    const drop = () => { edgeSock.destroy(); nodeSock.destroy(); };
    edgeSock.on('error', drop); nodeSock.on('error', drop);
    edgeSock.on('close', drop); nodeSock.on('close', drop);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port: server.address().port,
    mark() { return events.length; },
    slice(from) { return events.slice(from); },
    async close() {
      active?.edgeSock?.destroy(); active?.nodeSock?.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const RUST = path.resolve('rust');
execFileSync('cargo', ['build', '--release', '--locked', '-p', 'last-exit-edge'], { cwd: RUST, stdio: 'inherit' });
const binary = path.join(RUST, 'target', 'release', process.platform === 'win32' ? 'last-exit-edge.exe' : 'last-exit-edge');

const JOIN_TELEMETRY_SCRIPT = ({ wsProxyPort } = {}) => {
  const now = () => performance.timeOrigin + performance.now();
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const log = window.__joinTrace = {
    pageCreatedAt: now(),
    transport: null,
    connectAt: null,
    openAt: null,
    sent: [],
    received: [],
    datagramTimestamps: [],
    firstDatagramAt: null,
    readyBreakdown: null,
    welcomeBreakdown: null,
    sessionsEnded: [],
    pendingDecodes: [],
  };
  const inspectEnvelope = (entry, msg) => {
    entry.msgType = msg.type ?? entry.msgType;
    if (msg.type === 'welcome' && !log.welcomeBreakdown) {
      log.welcomeBreakdown = Object.fromEntries(
        Object.entries(msg).map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0])
      );
    }
    if (msg.type === 'ready' && !log.readyBreakdown) {
      log.readyBreakdown = Object.fromEntries(
        Object.entries(msg).map(([k, v]) => [k, JSON.stringify(v)?.length ?? 0])
      );
    }
  };
  const decodeCompressedEnvelope = async (entry, source) => {
    const raw = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
    if (!raw || raw.length < 3 || raw[0] !== 0xd2) return;
    let at = 1;
    while (at < raw.length && (raw[at++] & 0x80) !== 0) {}
    if (at >= raw.length) return;
    const stream = new Blob([raw.subarray(at)]).stream().pipeThrough(new DecompressionStream('gzip'));
    inspectEnvelope(entry, JSON.parse(await new Response(stream).text()));
  };
  const recordIncoming = (isBinary, payloadBytes, textOrBinary, firstByteAt, completeAt) => {
    const entry = { msgType: isBinary ? 'binary' : 'text', isBinary, payloadBytes, firstByteAt, completeAt };
    log.received.push(entry);
    if (!isBinary && typeof textOrBinary === 'string') {
      try { inspectEnvelope(entry, JSON.parse(textOrBinary)); } catch { /* ignore */ }
    } else if (isBinary && textOrBinary) {
      if (textOrBinary instanceof Blob || textOrBinary[0] === 0xd2) {
        log.pendingDecodes.push(decodeCompressedEnvelope(entry, textOrBinary).catch(() => {}));
      }
    }
  };
  const recordOutgoing = (isBinary, payloadBytes, textOrNull) => {
    let msgType = isBinary ? 'binary' : 'text';
    if (!isBinary && textOrNull) {
      try { msgType = JSON.parse(textOrNull).type ?? 'text'; } catch { /* ignore */ }
    }
    log.sent.push({ msgType, payloadBytes, at: now() });
  };

  const NativeWT = window.WebTransport;
  if (NativeWT) {
    window.WebTransport = class extends NativeWT {
      constructor(...a) {
        super(...a);
        log.transport = 'wt';
        log.connectAt = now();
        this.ready.then(() => { log.wtReadyAt = now(); }, () => {});
        const origCreateBi = this.createBidirectionalStream.bind(this);
        this.createBidirectionalStream = async (...b) => {
          const stream = await origCreateBi(...b);
          log.openAt = now();
          const writable = stream.writable, origGetWriter = writable.getWriter.bind(writable);
          writable.getWriter = (...w) => {
            const writer = origGetWriter(...w), origWrite = writer.write.bind(writer);
            writer.write = chunk => {
              if (chunk?.length >= 5) {
                const flag = chunk[4], payload = chunk.subarray(5);
                recordOutgoing(flag === 1, payload.length, flag === 0 ? decoder.decode(payload) : null);
              }
              return origWrite(chunk);
            };
            return writer;
          };
          const readable = stream.readable, origGetReader = readable.getReader.bind(readable);
          readable.getReader = (...r) => {
            const reader = origGetReader(...r), origRead = reader.read.bind(reader);
            let pending = new Uint8Array(0), frameStartAt = null;
            reader.read = async () => {
              const res = await origRead();
              const t = now();
              if (!res.done && res.value?.length) {
                const chunk = res.value;
                if (frameStartAt === null) frameStartAt = t;
                const joined = new Uint8Array(pending.length + chunk.length);
                joined.set(pending); joined.set(chunk, pending.length);
                let at = 0;
                while (joined.length - at >= 4) {
                  const len = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0);
                  if (len < 1 || joined.length - at < 4 + len) break;
                  const flag = joined[at + 4], payload = joined.subarray(at + 5, at + 4 + len);
                  const body = flag === 0 ? decoder.decode(payload) : (payload[0] === 0xd2 ? payload.slice() : null);
                  recordIncoming(flag === 1, payload.length, body, frameStartAt, t);
                  at += 4 + len;
                  frameStartAt = at < joined.length ? t : null;
                }
                pending = joined.subarray(at);
              }
              return res;
            };
            return reader;
          };
          return stream;
        };
        if (this.datagrams?.readable) {
          const dReadable = this.datagrams.readable, origDReader = dReadable.getReader.bind(dReadable);
          dReadable.getReader = (...r) => {
            const reader = origDReader(...r), origRead = reader.read.bind(reader);
            reader.read = async () => {
              const res = await origRead();
              if (!res.done && res.value) {
                const at = now();
                if (log.firstDatagramAt === null) log.firstDatagramAt = at;
                log.datagramTimestamps.push(at);
              }
              return res;
            };
            return reader;
          };
        }
        const opened = now();
        this.closed.then(
          info => log.sessionsEnded.push({ opened, at: now(), code: info?.closeCode ?? null, reason: info?.reason ?? '' }),
          error => log.sessionsEnded.push({ opened, at: now(), error: String(error) })
        );
      }
    };
  }

  const NativeWS = window.WebSocket;
  window.WebSocket = class extends NativeWS {
    constructor(url, ...a) {
      let targetUrl = url;
      if (wsProxyPort && typeof url === 'string') {
        const parsed = new URL(url, location.href);
        parsed.port = String(wsProxyPort);
        targetUrl = parsed.toString();
      }
      super(targetUrl, ...a);
      log.transport = 'ws';
      log.connectAt = now();
      this.addEventListener('open', () => { log.openAt = now(); });
      this.addEventListener('message', e => {
        const t = now();
        if (typeof e.data === 'string') {
          recordIncoming(false, encoder.encode(e.data).length, e.data, t, t);
        } else if (e.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(e.data);
          recordIncoming(true, e.data.byteLength, bytes[0] === 0xd2 ? bytes : null, t, t);
        } else if (e.data instanceof Blob) {
          recordIncoming(true, e.data.size, e.data, t, t);
        }
      });
      const origSend = this.send.bind(this);
      this.send = data => {
        const text = typeof data === 'string' ? data : null;
        const len = text !== null ? encoder.encode(text).length : (data?.byteLength ?? data?.size ?? 0);
        recordOutgoing(text === null, len, text);
        return origSend(data);
      };
      const opened = now();
      this.addEventListener('close', e => {
        log.sessionsEnded.push({ opened, at: now(), code: e.code, reason: e.reason, wasClean: e.wasClean });
      });
    }
  };
};

async function runOne(transport, profile, runIndex, { server, base, browser }, offer, linkTap) {
  const profileSeed = seed ^ (runIndex * 0x9E3779B1) ^ (NETWORK_PROFILES.findIndex(p => p.name === profile.name) * 0x85EBCA6B);
  const relay = transport === 'wt'
    ? await startLossyRelay({ target: offer.port, profile, seed: profileSeed, tick: TICK })
    : await startTcpDelayProxy({ target: server.http.address().port, profile, seed: profileSeed, rewriteHost: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  collectBrowserErrors(page, errors, { consoleErrors: true });

  if (transport === 'wt') {
    await page.route('**/api/client-config', async route => {
      const response = await route.fetch(), config = await response.json();
      config.webTransport = { ...config.webTransport, port: relay.port };
      await route.fulfill({ response, json: config });
    });
  }

  await page.addInitScript(JOIN_TELEMETRY_SCRIPT, { wsProxyPort: transport === 'ws' ? relay.port : null });

  // Wait until no prior session is still receiving frames over edgeLink.
  let sendsBefore = server.edgeLink.counts().sends;
  for (let quiet = 0; quiet < 3;) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const linked = server.edgeLink.counts().sends;
    quiet = linked === sendsBefore ? quiet + 1 : 0;
    sendsBefore = linked;
  }
  const tapFrom = linkTap.mark();
  const knownRooms = new Set(server.rooms.keys());
  let roomCreatedAt = null, matchReadyAt = null, matchStartAt = null;
  const pollRooms = setInterval(() => {
    for (const [id, room] of server.rooms) {
      if (knownRooms.has(id)) continue;
      if (roomCreatedAt === null) roomCreatedAt = now();
      if (matchReadyAt === null && room.match) matchReadyAt = now();
      if (matchStartAt === null && room.started) matchStartAt = now();
    }
  }, 5);

  const gotoStartedAt = now();
  try {
    const startUrl = `${base}/?seed=${mapSeed}&transport=${transport}&profile`;
    await page.goto(startUrl);
    const start = page.getByRole('button', { name: 'Start match', exact: true });
    await start.waitFor({ state: 'visible', timeout: 120000 });
    await start.click();
    await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 180000 });
    const liveAt = now();
    await page.waitForTimeout(300);

    const trace = await page.evaluate(async () => {
      await Promise.all(window.__joinTrace.pendingDecodes);
      const { pendingDecodes: _, ...rest } = window.__joinTrace;
      return rest;
    });
    const tapEvents = linkTap.slice(tapFrom);
    const relayCounts = await relay.counts();

    const findRecv = type => trace.received.find(m => m.msgType === type);
    const welcomeMsg = findRecv('welcome');
    const readyMsg = findRecv('ready');
    if (!welcomeMsg || !readyMsg) {
      const seen = [...new Set(trace.received.map(m => m.msgType))].join(', ');
      throw new Error(`Missing welcome/ready trace entry for ${transport} ${profile.name}#${runIndex} (received: ${seen || 'none'})`);
    }
    const datagramsBeforeLive = trace.datagramTimestamps.filter(at => at <= readyMsg.completeAt).length;
    const readyIdx = trace.received.indexOf(readyMsg);
    const beforeReady = readyIdx >= 0 ? trace.received.slice(0, readyIdx) : trace.received;
    const streamBytesBeforeReady = beforeReady.reduce((sum, m) => sum + m.payloadBytes, 0);
    const streamBytesThroughReady = streamBytesBeforeReady + (readyMsg?.payloadBytes ?? 0);
    const waitingMsgs = beforeReady.filter(m => m.msgType === 'binary' || m.msgType === 'state');
    const waitingBytes = waitingMsgs.reduce((sum, m) => sum + m.payloadBytes, 0);
    const lobbyBeforeReady = beforeReady.filter(m => m.msgType === 'lobby');
    const lobbyBytesBeforeReady = lobbyBeforeReady.reduce((sum, m) => sum + m.payloadBytes, 0);
    const pingBeforeReady = beforeReady.filter(m => m.msgType === 'ping');

    // Edge-link telemetry (WT only): compare DELIVER -> WRITTEN -> client receipt of `ready`.
    let edgeMetrics = null;
    if (transport === 'wt') {
      const openEv = tapEvents.find(e => e.type === 'OPEN');
      const sid = openEv?.sessionId;
      const sessionEvents = sid === undefined ? [] : tapEvents.filter(e => e.sessionId === sid);
      const delivers = sessionEvents.filter(e => e.type === 'DELIVER');
      const writtens = sessionEvents.filter(e => e.type === 'WRITTEN');
      let cumPayload = 0, readyCumEnd = null, readyDeliverAt = null;
      for (const d of delivers) {
        cumPayload += d.payloadBytes;
        if (d.msgType === 'ready' && readyDeliverAt === null) {
          readyDeliverAt = d.at;
          readyCumEnd = cumPayload;
        }
      }
      if (readyDeliverAt === null) {
        throw new Error(`Edge tap missed ready DELIVER frame for ${profile.name}#${runIndex}`);
      }
      const readyWrittenEv = writtens.find(w => w.writtenBytes >= readyCumEnd);
      edgeMetrics = {
        deliverFramesBeforeReady: delivers.filter(d => readyDeliverAt === null || d.at <= readyDeliverAt).length,
        deliverBytesThroughReady: readyCumEnd,
        readyDeliverToWrittenMs: readyDeliverAt && readyWrittenEv ? Math.round(readyWrittenEv.at - readyDeliverAt) : null,
        readyDeliverToClientMs: readyDeliverAt && readyMsg ? Math.round(readyMsg.completeAt - readyDeliverAt) : null,
        sendDatagramsBeforeLive: sessionEvents.filter(e => e.type === 'SEND' && (!readyMsg || e.at <= readyMsg.completeAt)).length,
      };
    }

    const rttMs = await page.evaluate(() => window.arenaDebug().rtt);
    const readySendStart = matchStartAt ?? readyMsg?.firstByteAt;
    const readyDeliveryMs = readyMsg && readySendStart ? Math.max(1, Math.round(readyMsg.completeAt - readySendStart)) : null;
    const readyThroughputKBps = readyMsg && readyDeliveryMs
      ? Math.round((readyMsg.payloadBytes / 1024) / (readyDeliveryMs / 1000) * 10) / 10
      : null;
    const totalStreamDurationMs = welcomeMsg && readyMsg ? Math.max(1, Math.round(readyMsg.completeAt - welcomeMsg.completeAt)) : null;
    const overallStreamKBps = totalStreamDurationMs
      ? Math.round(((streamBytesThroughReady - welcomeMsg.payloadBytes) / 1024) / (totalStreamDurationMs / 1000) * 10) / 10
      : null;

    return {
      transport,
      profile: profile.name,
      ordered: profile.ordered,
      run: runIndex,
      joinToLiveMs: Math.round(liveAt - gotoStartedAt),
      connectMs: trace.connectAt && trace.openAt ? Math.round(trace.openAt - trace.connectAt) : null,
      wtReadyMs: trace.connectAt && trace.wtReadyAt ? Math.round(trace.wtReadyAt - trace.connectAt) : null,
      welcomeWaitMs: trace.openAt && welcomeMsg ? Math.round(welcomeMsg.completeAt - trace.openAt) : null,
      mapGenMs: roomCreatedAt && matchReadyAt ? Math.round(matchReadyAt - roomCreatedAt) : null,
      readyDeliveryMs,
      readyStreamWindowMs: readyMsg ? Math.round(readyMsg.completeAt - readyMsg.firstByteAt) : null,
      readyThroughputKBps,
      overallStreamKBps,
      bytes: {
        welcome: welcomeMsg?.payloadBytes ?? null,
        waitingCount: waitingMsgs.length,
        waitingBytes,
        lobbyCountBeforeReady: lobbyBeforeReady.length,
        lobbyBytesBeforeReady,
        pingCountBeforeReady: pingBeforeReady.length,
        streamBeforeReady: streamBytesBeforeReady,
        ready: readyMsg?.payloadBytes ?? null,
        streamThroughReady: streamBytesThroughReady,
        welcomeBreakdown: trace.welcomeBreakdown,
        readyBreakdown: trace.readyBreakdown,
      },
      datagramsBeforeLive,
      edgeMetrics,
      rttMs,
      relay: relayCounts,
      sessionsEnded: trace.sessionsEnded,
      errors,
    };
  } finally {
    clearInterval(pollRooms);
    await page.close();
    await relay.stop();
  }
}

const lock = await acquireMachineLock('bench');
const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-join-latency-'));
const session = await serveWithBrowser({ profile: false, profileSummary: false, roomThreads: false, edgeLink: 0, replayDir });
const linkTap = await startEdgeLinkTap(session.server.edgeLink.port);
const edge = spawn(binary, ['--link', `127.0.0.1:${linkTap.port}`, '--port', '0'], { stdio: ['ignore', 'ignore', 'inherit'] });
const results = [], browserVersion = session.browser.version();

try {
  let offer = null;
  for (let i = 0; i < 100 && !offer; i++) {
    offer = (await (await fetch(`${session.base}/api/client-config`)).json()).webTransport;
    if (!offer) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!offer) throw new Error('The edge never linked.');

  for (const profile of chosen) {
    for (let i = 0; i < runs; i++) {
      for (const transport of transports) {
        const r = await runOne(transport, profile, i, session, offer, linkTap);
        results.push(r);
        console.log(
          `${transport.toUpperCase()} ${profile.name}#${i}: join ${r.joinToLiveMs} ms | connect ${r.connectMs} ms | ` +
          `mapGen ${r.mapGenMs} ms | readyDeliv ${r.readyDeliveryMs} ms (${r.readyThroughputKBps} KB/s) | ` +
          `beforeReady ${r.bytes.streamBeforeReady} B (${r.bytes.waitingCount} wait) + ready ${r.bytes.ready} B | ` +
          `errors ${r.errors.length}`
        );
      }
    }
  }
} finally {
  edge.kill();
  await linkTap.close();
  try { await session.close(); } finally { await rm(replayDir, { recursive: true, force: true }); await lock.release(); }
}

const summary = {};
for (const profile of chosen) {
  summary[profile.name] = {};
  for (const transport of transports) {
    const group = results.filter(r => r.profile === profile.name && r.transport === transport);
    summary[profile.name][transport] = {
      joinToLiveMs: stats(group.map(r => r.joinToLiveMs)),
      connectMs: stats(group.map(r => r.connectMs)),
      mapGenMs: stats(group.map(r => r.mapGenMs).filter(v => v !== null)),
      readyDeliveryMs: stats(group.map(r => r.readyDeliveryMs).filter(v => v !== null)),
      readyThroughputKBps: stats(group.map(r => r.readyThroughputKBps).filter(v => v !== null)),
      streamBeforeReadyBytes: stats(group.map(r => r.bytes.streamBeforeReady)),
      readyBytes: stats(group.map(r => r.bytes.ready).filter(v => v !== null)),
      streamThroughReadyBytes: stats(group.map(r => r.bytes.streamThroughReady)),
    };
  }
}

const record = {
  issue: 1201,
  tool: 'tools/perf/join-latency-1201.mjs',
  date: new Date().toISOString(),
  node: process.version,
  browser: browserVersion,
  settings: { runs, seed, mapSeed, tickMs: TICK, ordered, transports, profiles: chosen },
  summary,
  results,
};
if (args.get('out')) await writeFile(args.get('out'), JSON.stringify(record, null, 1) + '\n');
setTimeout(() => process.exit(0), 200);
