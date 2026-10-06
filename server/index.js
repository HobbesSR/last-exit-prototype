import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { createHash } from 'node:crypto';
import { HZ } from '../shared/simulation/rules.ts';
import * as profiler from '../shared/profiler.ts';
import { createFileReplayStore } from './replay-store.js';
import { createRoomService } from './room-service.js';
import { installHttpApi } from './http-api.js';
import { attachWebSockets } from './websocket.js';
import { startScheduler } from './scheduler.js';
import { serveSharedModules } from './shared-assets.js';
import { getDevNavConfig } from '../shared/dev-nav-server.js';
import { devToolsPolicy } from './protocol.js';
export { EMPTY_ROOM_GRACE_MS } from './room-service.js';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE_ID = createHash('sha256').update(path.resolve(ROOT)).digest('hex');

function lanUrls(port) {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}
function printListeningUrls(host, port) {
  console.log(`Last Exit is running at http://${host}:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    const urls = lanUrls(port);
    if (urls.length) {
      console.log('LAN clients can join at:');
      for (const url of urls) console.log(`  ${url}`);
    } else {
      console.log('No LAN IPv4 address was found. Check your network connection.');
    }
  }
}

export async function createArenaServer({ replayDir = path.join(ROOT, 'replays'), profile = process.env.PROFILE === '1', profileSummary = true, devTools = process.env.DEV_TOOLS } = {}) {
  profiler.enable(profile);
  const policy = devToolsPolicy(devTools);
  const replays = await createFileReplayStore(replayDir);
  const service = createRoomService({ replays, devTools: policy });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules/phaser/dist')));
  app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules/lucide/dist/umd')));
  app.use('/vendor/sat', express.static(path.join(ROOT, 'node_modules/sat')));
  app.use('/shared', serveSharedModules(path.join(ROOT, 'shared')));
  app.get('/shared/dev-nav.js', (_req, res) => res.sendFile(path.join(ROOT, 'shared/dev-nav.js')));
  app.get('/shared/dev-nav.css', (_req, res) => res.sendFile(path.join(ROOT, 'shared/dev-nav.css')));
  // The micro labs load map generation's micro half and the kernel it builds on (docs 50).
  app.use('/map/micro', serveSharedModules(path.join(ROOT, 'map/micro')));
  app.use('/map/kernel', serveSharedModules(path.join(ROOT, 'map/kernel')));
  app.get('/dev-nav-peer.json', (_req, res) => res.json({ kind: 'game', workspace: WORKSPACE_ID }));
  app.get('/dev-nav-config.json', async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await getDevNavConfig({
      kind: 'game', host: req.hostname, localPort: req.socket.localPort,
      peerPort: process.env.MAPGEN_PORT, workspaceId: WORKSPACE_ID,
    }));
  });
  app.use(express.static(path.join(ROOT, 'public')));
  installHttpApi(app, service, replays);
  const http = createHttpServer(app), wss = attachWebSockets(http, service);
  const stopScheduler = startScheduler(service.advance);
  const summary = setInterval(() => {
    if (!profileSummary || !profiler.profiling() || !profiler.frameCount()) return;
    console.log(`\nprofile: ${profiler.frameCount()} loop frames, budget ${(1000 / HZ).toFixed(1)} ms${profiler.format()}`);
  }, 10000);
  summary.unref?.();
  let closing;
  function close() {
    if (!closing) {
      stopScheduler(); clearInterval(summary);
      for (const ws of wss.clients) ws.terminate();
      // Stop admitting connections before waiting for potentially slow archive publication.
      const socketsClosed = new Promise(resolve => wss.close(resolve));
      const httpClosed = http.listening ? new Promise(resolve => http.close(resolve)) : Promise.resolve();
      closing = Promise.all([service.close(), socketsClosed, httpClosed]).then(() => undefined);
    }
    return closing;
  }
  return { http, close, rooms: service.rooms, profiler };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--dev-tools=all` (what `npm run dev` passes) outranks DEV_TOOLS from the environment or .env.local.
  const devTools = process.argv.find(arg => arg.startsWith('--dev-tools='))?.slice('--dev-tools='.length);
  const arena = await createArenaServer(devTools === undefined ? {} : { devTools });
  const lan = process.argv.includes('--lan') || process.env.LAN === '1';
  const host = process.env.HOST || (lan ? '0.0.0.0' : '127.0.0.1');
  // 3000 is taken by the local Forgejo. An explicit PORT (e.g. a worktree's .env.local) is
  // honoured exactly: drifting upward would land on another agent's assigned port.
  const explicit = process.env.PORT !== undefined && process.env.PORT !== '';
  const firstPort = explicit ? Number(process.env.PORT) : 3100;
  let port = firstPort;
  arena.http.on('error', error => {
    if (error.code === 'EADDRINUSE' && !explicit && port < firstPort + 9) arena.http.listen(++port, host);
    else if (error.code === 'EADDRINUSE') { console.error(`Port ${port} is in use${explicit ? ' (set by PORT)' : ''}. Stop the server holding it, or choose another port; PORT=0 picks any free one.`); process.exit(1); }
    else { console.error(error); process.exit(1); }
  });
  // The bound port, not the requested one: PORT=0 asks the OS for any free port.
  arena.http.on('listening', () => printListeningUrls(host, arena.http.address().port));
  arena.http.listen(port, host);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await arena.close(); process.exit(0); });
}
