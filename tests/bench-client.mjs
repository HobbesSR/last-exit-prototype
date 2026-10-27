// Client frame benchmark: drives a real match in installed Chrome with profiling enabled and reports
// the browser-side series: our per-frame JavaScript (render.frame), Phaser's own render pass
// (render.draw), and the observed gap between authoritative server states. GPU execution itself is
// not measured, and headless Chrome may use software GL; pass --headed for a real GPU.
// --viewport=WxH and --dpr=N match a reported device's window (a diagnostics download records both);
// --diagnostics=FILE also saves the player-facing Replays download at the end of the run.
// --software-gl disables the GPU, so WebGL runs on SwiftShader, one of the drawing paths #549 compared.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createArenaServer } from '../server/index.js';
import { listen } from './helpers/listen.js';
import { acquireMachineLock } from './helpers/machine-lock.js';
import { format } from '../shared/profiler.ts';
import { HZ } from '../shared/simulation.ts';
import { canOccupy } from '../shared/movement.ts';
import path from 'node:path';
import { arrangeCrowd } from './crowd-workload.mjs';
import { cliArgs } from './helpers/args.js';
import { createPhysicsMatch } from '../server/match.js';
import { contentById } from '../shared/simulation/content.ts';

const args = cliArgs();
const seconds = Number(args.get('seconds') ?? 12);
const [viewportWidth, viewportHeight] = (args.get('viewport') ?? '1440x1000').split('x').map(Number);
const deviceScaleFactor = Number(args.get('dpr') ?? 1);
if (args.has('physics') && (args.has('location') || args.has('spectator') || args.get('mode') === 'spectator'))
  throw new Error('--physics currently supports the live entry workload only');
const physicsContent = args.has('physics') ? args.get('content') ?? 'content-physics-8' : null;
await acquireMachineLock('bench');
await mkdir('test-results', { recursive: true });
const server = await createArenaServer({ replayDir: path.resolve('test-results/replays'),
  ...(physicsContent ? { content: () => contentById(physicsContent), matchFactory: createPhysicsMatch } : {}),
  ...(args.has('server-profile') ? { profile: true, profileSummary: false } : {}) });
const base = await listen(server);
const browser = await chromium.launch({ channel: 'chrome', headless: !args.has('headed'), args: args.has('software-gl') ? ['--disable-gpu'] : [] });
try {
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor });
  await page.goto(`${base}/?profile=1&seed=${args.get('seed') ?? 4217}${args.has('size') ? `&size=${args.get('size')}` : ''}`);
  const spectator = args.has('spectator') || args.get('mode') === 'spectator';
  let workload;
  // The lobby opens while the map generates (#258); the match to arrange exists only once it is built.
  const builtMatch = async () => {
    await page.waitForFunction(() => window.arenaDebug?.().me);
    const info = await page.evaluate(() => window.arenaDebug()), room = server.rooms.get(info.room);
    while (!room.game) await new Promise(resolve => setTimeout(resolve, 50));
    return { info, game: room.game };
  };
  if (['crowded', 'offscreen'].includes(args.get('location')) && !spectator) {
    const { info, game } = await builtMatch();
    workload = arrangeCrowd(game, info.me.id, { location: args.get('location'), ai: args.get('actors') !== 'idle' });
  }
  if (args.get('location') === 'dense' && !spectator) {
    const { info, game } = await builtMatch();
    const player = game.players.find(p => p.id === info.me.id);
    const site = game.map.items.filter(item => item.buildingId && canOccupy(game.map, item.x, item.y, player.role === 'gladiator' ? 23 : 12))
      .sort((a, b) => Math.abs(a.x - game.map.width / 2) - Math.abs(b.x - game.map.width / 2))[0];
    if (!site) throw new Error('Dense benchmark needs a usable building interior');
    Object.assign(player, { x: site.x, y: site.y });
  }
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  // A 36 × 18 map can still be generating for half a minute after the start (42.2).
  await page.waitForFunction(() => window.arenaDebug?.().phase === 'live' && window.arenaDebug().tick > 3, null, { timeout: 90000 });
  if (spectator) {
    await page.evaluate(() => window.arenaSpectate());
    await page.waitForFunction(() => document.getElementById('connection-text').textContent === 'SPECTATING' && window.arenaDebug().tick > 5);
  }
  await page.evaluate(() => { window.arenaProfiling(false); window.arenaProfiling(true); });
  if (args.has('server-profile')) server.profiler.reset();
  const measuredAt = performance.now();
  if (!workload && !spectator) await page.keyboard.down('KeyD');
  await page.waitForTimeout(seconds * 1000);
  if (!workload && !spectator) await page.keyboard.up('KeyD');
  const { frames, series } = await page.evaluate(() => window.arenaProfile());
  const physics = physicsContent && await page.evaluate(() => {
    const debug = window.arenaDebug();
    return { version: debug.version, prediction: debug.physicsPrediction };
  });
  const elapsedSeconds = (performance.now() - measuredAt) / 1000;
  const find = name => series.find(s => s.name === name);
  const delta = find('render.delta'), gap = find('net.stateGap'), bytes = find('net.stateBytes');
  const crowd = workload && await page.evaluate(() => {
    const d = window.arenaDebug();
    return { tick: d.tick, transmittedActors: d.actorCount, visibleActors: d.actors.filter(a => a.visible).length, camera: d.camera, cameraWidth: d.cameraWidth };
  });
  const serverProfile = args.has('server-profile') ? { frames: server.profiler.frameCount(), series: server.profiler.report() } : undefined;
  if (args.has('diagnostics')) {
    await page.getByRole('button', { name: 'Replays', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download performance diagnostics', exact: true }).click();
    await mkdir(path.dirname(path.resolve(args.get('diagnostics'))), { recursive: true });
    await (await download).saveAs(path.resolve(args.get('diagnostics')));
  }
  if (args.has('json')) console.log(JSON.stringify({ frames, series, ...(physics ? { physics, content: physicsContent } : {}), ...(workload ? { workload, crowd } : {}), ...(serverProfile ? { server: serverProfile } : {}) }, null, 2));
  else {
    const benchmarkLabel = spectator ? 'spectator (whole arena)' : args.get('location') || 'entry';
    console.log(`Last Exit client benchmark — ${benchmarkLabel}, ${elapsedSeconds.toFixed(2)}s, ${frames} rendered frames (${(frames / elapsedSeconds).toFixed(1)} fps average)`);
    if (delta) console.log(`frame time  mean ${delta.mean.toFixed(2)} ms   p50 ${delta.p50.toFixed(2)}   p95 ${delta.p95.toFixed(2)}   max ${delta.max.toFixed(2)}   (60 fps budget 16.7 ms)`);
    if (gap) console.log(`state gap   mean ${gap.mean.toFixed(1)} ms   p50 ${gap.p50.toFixed(1)}   p95 ${gap.p95.toFixed(1)}   max ${gap.max.toFixed(1)}   over ${gap.calls} packets   (server ${HZ} Hz = ${(1000 / HZ).toFixed(1)} ms)`);
    if (bytes) console.log(`state size  mean ${(bytes.mean / 1024).toFixed(1)} KiB, p95 ${(bytes.p95 / 1024).toFixed(1)} KiB per authoritative frame`);
    console.log(format(series.filter(s => s !== delta && s !== gap && s !== bytes)));
    console.log('\nrender.frame is inclusive: camera, vision, cover, world and actors are counted inside it.');
    console.log('Headless Chrome may fall back to software GL, so treat GPU-bound draw cost as a ceiling.');
    if (physics) console.log('Physics workload:', JSON.stringify({ content: physicsContent, ...physics }));
    if (workload) console.log('Crowd workload:', JSON.stringify({ ...workload, ...crowd }));
    if (serverProfile) console.log('Server profile:\n' + format(serverProfile.series));
  }
} finally {
  await browser.close();
  await server.close();
}
