// Client frame benchmark: drives a real match in installed Chrome with profiling enabled and reports
// the browser-side series. GPU work is not measured here; the useful numbers are the JavaScript costs
// per frame (vision, cover, HUD) and the observed gap between authoritative server states.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createArenaServer } from '../server/index.js';
import { format } from '../shared/profiler.js';
import { HZ } from '../shared/simulation.js';
import path from 'node:path';
import { arrangeCrowd } from './crowd-workload.mjs';

const args = new Map(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const seconds = Number(args.get('seconds') ?? 12);
await mkdir('test-results', { recursive: true });
const server = await createArenaServer({ replayDir: path.resolve('test-results/replays'),
  ...(args.has('server-profile') ? { profile: true, profileSummary: false } : {}) });
await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.http.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: !args.has('headed') });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${base}/?profile=1`);
  let workload;
  if (['crowded', 'offscreen'].includes(args.get('location'))) {
    await page.waitForFunction(() => window.arenaDebug?.().me);
    const info = await page.evaluate(() => window.arenaDebug());
    workload = arrangeCrowd(server.rooms.get(info.room).game, info.me.id, { location: args.get('location'), ai: args.get('actors') !== 'idle' });
  }
  if (args.get('location') === 'dense') {
    await page.waitForFunction(() => window.arenaDebug?.().me);
    const info = await page.evaluate(() => window.arenaDebug());
    const game = server.rooms.get(info.room).game;
    const building = [...game.map.buildings].sort((a, b) => Math.abs(a.x - game.map.width / 2) - Math.abs(b.x - game.map.width / 2))[0];
    const player = game.players.find(p => p.id === info.me.id);
    Object.assign(player, { x: building.x + 125, y: building.y + 305 });
  }
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug?.().tick > 3, null, { timeout: 15000 });
  await page.evaluate(() => { window.arenaProfiling(false); window.arenaProfiling(true); });
  if (args.has('server-profile')) server.profiler.reset();
  const measuredAt = performance.now();
  if (!workload) await page.keyboard.down('KeyD');
  await page.waitForTimeout(seconds * 1000);
  if (!workload) await page.keyboard.up('KeyD');
  const { frames, series } = await page.evaluate(() => window.arenaProfile());
  const elapsedSeconds = (performance.now() - measuredAt) / 1000;
  const find = name => series.find(s => s.name === name);
  const delta = find('render.delta'), gap = find('net.stateGap'), bytes = find('net.stateBytes');
  const crowd = workload && await page.evaluate(() => {
    const d = window.arenaDebug();
    return { tick: d.tick, transmittedActors: d.actorCount, visibleActors: d.actors.filter(a => a.visible).length, camera: d.camera, cameraWidth: d.cameraWidth };
  });
  const serverProfile = args.has('server-profile') ? { frames: server.profiler.frameCount(), series: server.profiler.report() } : undefined;
  if (args.has('json')) console.log(JSON.stringify({ frames, series, ...(workload ? { workload, crowd } : {}), ...(serverProfile ? { server: serverProfile } : {}) }, null, 2));
  else {
    console.log(`Last Exit client benchmark — ${args.get('location') || 'entry'}, ${elapsedSeconds.toFixed(2)}s, ${frames} rendered frames (${(frames / elapsedSeconds).toFixed(1)} fps average)`);
    if (delta) console.log(`frame time  mean ${delta.mean.toFixed(2)} ms   p50 ${delta.p50.toFixed(2)}   p95 ${delta.p95.toFixed(2)}   max ${delta.max.toFixed(2)}   (60 fps budget 16.7 ms)`);
    if (gap) console.log(`state gap   mean ${gap.mean.toFixed(1)} ms   p50 ${gap.p50.toFixed(1)}   p95 ${gap.p95.toFixed(1)}   max ${gap.max.toFixed(1)}   over ${gap.calls} packets   (server ${HZ} Hz = ${(1000 / HZ).toFixed(1)} ms)`);
    if (bytes) console.log(`state size  mean ${(bytes.mean / 1024).toFixed(1)} KiB, p95 ${(bytes.p95 / 1024).toFixed(1)} KiB per authoritative frame`);
    console.log(format(series.filter(s => s !== delta && s !== gap && s !== bytes)));
    console.log('\nrender.frame is inclusive: camera, vision, cover, world and actors are counted inside it.');
    console.log('Headless Chrome may fall back to software GL, so treat GPU-bound draw cost as a ceiling.');
    if (workload) console.log('Crowd workload:', JSON.stringify({ ...workload, ...crowd }));
    if (serverProfile) console.log('Server profile:\n' + format(serverProfile.series));
  }
} finally {
  await browser.close();
  await server.close();
}
