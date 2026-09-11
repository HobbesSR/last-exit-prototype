import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { HZ } from '../shared/simulation/rules.js';
import * as profiler from '../shared/profiler.js';
import { createFileReplayStore } from './replay-store.js';
import { createRoomService } from './room-service.js';
import { installHttpApi } from './http-api.js';
import { attachWebSockets } from './websocket.js';
import { startScheduler } from './scheduler.js';
export { EMPTY_ROOM_GRACE_MS } from './room-service.js';
const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function lanUrls(port) {
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

export async function createArenaServer({ replayDir = path.join(ROOT, 'replays'), profile = process.env.PROFILE === '1' } = {}) {
  profiler.enable(profile);
  const replays = await createFileReplayStore(replayDir);
  const service = createRoomService({ replays });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules/phaser/dist')));
  app.use('/vendor/lucide', express.static(path.join(ROOT, 'node_modules/lucide/dist/umd')));
  app.use('/vendor/sat', express.static(path.join(ROOT, 'node_modules/sat')));
  app.use('/shared', express.static(path.join(ROOT, 'shared')));
  app.use(express.static(path.join(ROOT, 'public')));
  installHttpApi(app, service, replays);
  const http = createHttpServer(app), wss = attachWebSockets(http, service);
  const stopScheduler = startScheduler(service.advance);
  const summary = setInterval(() => {
    if (!profiler.profiling() || !profiler.frameCount()) return;
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
  const arena = await createArenaServer();
  const lan = process.argv.includes('--lan') || process.env.LAN === '1';
  const host = process.env.HOST || (lan ? '0.0.0.0' : '127.0.0.1');
  const firstPort = Number(process.env.PORT || 3000);
  let port = firstPort;
  arena.http.on('error', error => {
    if (error.code === 'EADDRINUSE' && port < firstPort + 20) arena.http.listen(++port, host);
    else { console.error(error); process.exit(1); }
  });
  arena.http.on('listening', () => printListeningUrls(host, port));
  arena.http.listen(port, host);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await arena.close(); process.exit(0); });
}
