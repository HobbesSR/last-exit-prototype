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
import { createRoomDirectory } from './room-directory.js';
import { createMapGenerator } from './map-generator.js';
import { createMapPool, MAP_POOL_SIZE } from './map-pool.js';
import { installHttpApi } from './http-api.js';
import { attachWebSockets } from './websocket.js';
import { startScheduler } from './scheduler.js';
import { serveSharedModules } from './shared-assets.js';
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
function printListeningUrls(host, port, devTools) {
  const localHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log(`Last Exit is running at http://${localHost}:${port}`);
  if (devTools !== undefined) {
    console.log(`Developer Portal is available at http://${localHost}:${port}/dev`);
  }
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

/**
 * `generateMap` replaces the worker, for tests that need to control generation. `mapPool` is how many maps
 * to keep ready per size (#266); none unless asked, so tests and benchmarks run without background generation.
 */
export async function createArenaServer({ replayDir = path.join(ROOT, 'replays'), profile = process.env.PROFILE === '1', profileSummary = true, devTools = process.env.DEV_TOOLS, generateMap, mapPool = 0 } = {}) {
  profiler.enable(profile);
  const policy = devToolsPolicy(devTools);
  const replays = await createFileReplayStore(replayDir);
  // Maps are generated on a worker thread, so creating a room never stalls the others (#253).
  const maps = generateMap ? null : createMapGenerator();
  // The pool refills on its own worker, so a room asking for a particular seed never queues behind it.
  const poolMaps = mapPool > 0 && !generateMap ? createMapGenerator() : null;
  const pool = mapPool > 0 ? createMapPool({ generate: generateMap ?? poolMaps.generate, perSize: mapPool }) : null;
  const service = createRoomService({ replays, devTools: policy });
  const directory = createRoomDirectory({ host: service, generateMap: generateMap ?? maps.generate, pool, devTools: policy });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules/phaser/dist')));
  app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules/lucide/dist/umd')));
  app.use('/vendor/sat', express.static(path.join(ROOT, 'node_modules/sat')));
  app.get('/vendor/sat.mjs', async (req, res) => { const { vendorModule } = await import('./vendor-modules.js'); res.type('application/javascript').send(vendorModule('sat')); });
  app.get('/vendor/pathfinding.mjs', async (req, res) => { const { vendorModule } = await import('./vendor-modules.js'); res.type('application/javascript').send(vendorModule('pathfinding')); });

  app.use('/shared', serveSharedModules(path.join(ROOT, 'shared')));
  app.get('/shared/dev-nav.js', (_req, res) => res.sendFile(path.join(ROOT, 'shared/dev-nav.js')));
  app.get('/shared/dev-nav.css', (_req, res) => res.sendFile(path.join(ROOT, 'shared/dev-nav.css')));

  // Serve all of /map (micro, macro, kernel, tools, and root .ts files like chain.ts)
  // TypeScript files get stripped, everything else is served statically
  app.use('/map', serveSharedModules(path.join(ROOT, 'map')));
  app.use('/map', express.static(path.join(ROOT, 'map')));

  app.get('/dev', (req, res) => res.sendFile(path.join(ROOT, 'public/dev/index.html')));
  app.get('/dev/map', (req, res) => res.sendFile(path.join(ROOT, 'map/tools/lab/index.html')));
  app.get('/dev/micro', (req, res) => res.sendFile(path.join(ROOT, 'public/micro-lab.html')));
  app.get('/dev/micro/decomposition', (req, res) => res.sendFile(path.join(ROOT, 'public/decomposition-lab.html')));
  app.get('/dev/micro/generation', (req, res) => res.sendFile(path.join(ROOT, 'public/generation-demo.html')));

  app.get('/dev-nav-peer.json', (_req, res) => res.json({ kind: 'game', workspace: WORKSPACE_ID }));
  app.get('/dev-nav-config.json', async (req, res) => {
    // Map lab is now integrated, so we override the config to point to ourselves
    res.set('Cache-Control', 'no-store').json({ mainUrl: "", mapgenUrl: "/map/tools/lab" });
  });
  app.use(express.static(path.join(ROOT, 'public')));
  installHttpApi(app, service, directory, replays, pool);
  // Matchmaking messages go to the directory, which answers with a room for the host to admit into.
  const http = createHttpServer(app), wss = attachWebSockets(http, { connect: service.connect, receive: directory.receive, disconnect: service.disconnect });
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
      pool?.close();
      closing = Promise.all([service.close(), socketsClosed, httpClosed, maps?.close(), poolMaps?.close()]).then(() => undefined);
    }
    return closing;
  }
  return { http, close, rooms: service.rooms, profiler };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `--dev-tools=all` (what `npm run dev` passes) outranks DEV_TOOLS from the environment or .env.local.
  const devTools = process.argv.find(arg => arg.startsWith('--dev-tools='))?.slice('--dev-tools='.length);
  // MAP_POOL sets how many maps are kept ready per size (#266); 0 turns the pool off.
  const mapPool = process.env.MAP_POOL ? Number(process.env.MAP_POOL) : MAP_POOL_SIZE;
  const arena = await createArenaServer(devTools === undefined ? { mapPool } : { devTools, mapPool });
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
  arena.http.on('listening', () => printListeningUrls(host, arena.http.address().port, devTools));
  arena.http.listen(port, host);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await arena.close(); process.exit(0); });
}
