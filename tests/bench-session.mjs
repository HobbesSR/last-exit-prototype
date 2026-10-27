// Long-session probe (#549): one match in installed Chrome, sampled every interval for client frame
// time, our per-frame JavaScript (render.frame), Phaser's render pass (render.draw), received/shown
// actors, heap and the server's tick cost, so a cost that builds over minutes shows as a trend.
// --roam walks the player around, --immortal keeps them alive, --native gives Chrome a real device
// scale factor and window instead of emulating one, so the compositor works at the physical size.
// --software-gl or --chrome-args="..." change the browser's drawing path. --root=<checkout> drives
// that checkout's server and client instead, for comparing a historical commit on the same device.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listen } from './helpers/listen.js';
import { acquireMachineLock } from './helpers/machine-lock.js';
import { cliArgs } from './helpers/args.js';

const args = cliArgs();
const root = path.resolve(args.get('root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const seconds = Number(args.get('seconds') ?? 300), interval = Number(args.get('interval') ?? 15);
const [width, height] = (args.get('viewport') ?? '1440x1000').split('x').map(Number);
const dpr = Number(args.get('dpr') ?? 1), native = args.has('native');
const out = args.has('out') && path.resolve(args.get('out')), diagnostics = args.has('diagnostics') && path.resolve(args.get('diagnostics'));
const chromeArgs = [...(args.has('software-gl') ? ['--disable-gpu'] : []), ...(args.get('chrome-args')?.split(' ') ?? []),
  ...(native ? [`--force-device-scale-factor=${dpr}`, `--window-size=${width},${height + 90}`, '--window-position=0,0'] : [])];
await acquireMachineLock('bench');
// The checkout serves its own public/ and resolves its own packages from its working directory.
process.chdir(root);
const { chromium } = createRequire(path.join(root, 'package.json'))('@playwright/test');
const { createArenaServer } = await import(pathToFileURL(path.join(root, 'server/index.js')).href);
const server = await createArenaServer({ replayDir: path.join(root, 'test-results/replays'), profile: true, profileSummary: false });
const base = await listen(server);
const browser = await chromium.launch({ channel: 'chrome', headless: !args.has('headed'), args: chromeArgs });
const rows = [];
try {
  const page = await browser.newPage(native ? { viewport: null } : { viewport: { width, height }, deviceScaleFactor: dpr });
  await page.goto(`${base}/?profile=1&seed=${args.get('seed') ?? 4217}${args.has('size') ? `&size=${args.get('size')}` : ''}`);
  await page.waitForFunction(() => window.arenaDebug?.().me);
  const info = await page.evaluate(() => window.arenaDebug()), room = server.rooms.get(info.room);
  // The lobby opens while the map generates (#258); the match exists only once it is built.
  while (!room.game) await new Promise(resolve => setTimeout(resolve, 50));
  await page.getByRole('button', { name: 'Start match', exact: true }).click();
  await page.waitForFunction(() => window.arenaDebug?.().tick > 3, null, { timeout: 60000 });
  const me = () => room.game.players.find(p => p.id === info.me.id);
  const environment = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl'), debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { adapter: gl ? gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null,
      viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio }, userAgent: navigator.userAgent };
  });
  console.log(JSON.stringify(environment));
  const keys = ['KeyD', 'KeyW', 'KeyD', 'KeyS', 'KeyD', 'KeyA', 'KeyS', 'KeyD'];
  let held = null, step = 0, lastFrames = 0, lastAt = performance.now();
  const started = performance.now();
  server.profiler.reset();
  while (performance.now() - started < seconds * 1000) {
    const sliceEnd = performance.now() + Math.min(interval * 1000, seconds * 1000 - (performance.now() - started));
    while (performance.now() < sliceEnd) {
      if (args.has('roam')) { if (held) await page.keyboard.up(held); held = keys[step++ % keys.length]; await page.keyboard.down(held); }
      if (args.has('immortal') && me()) me().shield = 1e6;
      await page.waitForTimeout(Math.min(4000, Math.max(0, sliceEnd - performance.now())));
    }
    // The client series are rolling windows of their last 600 samples, about the last ten seconds.
    const client = await page.evaluate(() => {
      const { frames, series } = window.arenaProfile(), d = window.arenaDebug();
      const pick = name => { const s = series.find(s => s.name === name); return s && { mean: +s.mean.toFixed(2), p95: +s.p95.toFixed(2), max: +s.max.toFixed(2) }; };
      return { frames, frame: pick('render.delta'), js: pick('render.frame'), draw: pick('render.draw'), gap: pick('net.stateGap'), bytes: pick('net.stateBytes'),
        phases: Object.fromEntries(series.filter(s => /^render\.(?!delta|frame$|draw$)/.test(s.name)).map(s => [s.name.slice(7), +s.mean.toFixed(2)])),
        discovered: d.discoveredCount, tick: d.tick, phase: d.phase, received: d.actorCount, shown: d.actors?.filter(a => a.visible).length,
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null };
    });
    const now = performance.now(), fps = +((client.frames - lastFrames) / ((now - lastAt) / 1000)).toFixed(1);
    lastFrames = client.frames; lastAt = now;
    const tick = server.profiler.report().find(s => s.name === 'loop.tick');
    const row = { at: Math.round((now - started) / 1000), fps, ...client, serverTick: tick && { mean: +tick.mean.toFixed(2), p95: +tick.p95.toFixed(2), max: +tick.max.toFixed(2) } };
    server.profiler.reset();
    rows.push(row);
    console.log(`${String(row.at).padStart(4)}s tick ${row.tick} ${row.phase} fps ${fps} frame ${row.frame?.mean}/${row.frame?.p95}/${row.frame?.max} js ${row.js?.mean} draw ${row.draw?.mean ?? '-'}` +
      ` actors ${row.received}/${row.shown} heap ${row.heapMB} MB | server tick ${row.serverTick?.mean}/${row.serverTick?.p95}/${row.serverTick?.max} ms` +
      ` | ${Object.entries(row.phases).filter(([, ms]) => ms >= 0.05).map(([name, ms]) => `${name} ${ms}`).join(' ')}`);
    if (client.phase === 'finished') break;
  }
  if (held) await page.keyboard.up(held);
  if (diagnostics) {
    await page.getByRole('button', { name: 'Replays', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download performance diagnostics', exact: true }).click();
    await (await download).saveAs(diagnostics);
  }
  if (out) await writeFile(out, JSON.stringify({ environment, args: Object.fromEntries(args), rows }, null, 2));
} finally {
  await browser.close();
  await server.close();
}
