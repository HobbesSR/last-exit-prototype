// Records a scripted gameplay clip in installed Chrome and encodes it to MP4 and GIF with ffmpeg.
//
// Frames come from the DevTools screencast rather than repeated screenshots, which caps out around
// seven a second and looks like a slideshow. Each frame carries its own timestamp and is fed to ffmpeg
// through a concat list, so the clip plays back at the speed the match was actually played at.
//
// The run steers toward real objectives rather than holding keys blindly: bots compete for the same
// loot, so a fixed key sequence records a contestant who never finds a blaster and shoots nothing.
//   node tests/demo.mjs [--seed=4217] [--out=media]
import { chromium } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createArenaServer } from '../server/index.js';
import { lineClear } from '../shared/movement.js';
import path from 'node:path';

const run = promisify(execFile);
const args = new Map(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const seed = Number(args.get('seed') ?? 4217);
const outDir = path.resolve(args.get('out') ?? 'media');
const frameDir = path.resolve('test-results/demo-frames');
const WIDTH = 1280, HEIGHT = 720, HUD_TOP = 72;

await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const server = await createArenaServer({ replayDir: path.resolve('test-results/replays') });
await new Promise(resolve => server.http.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.http.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });

const frames = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', async event => {
  frames.push({ data: event.data, at: event.metadata.timestamp * 1000 });
  try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }); } catch { /* stopped */ }
});

const held = new Set();
async function press(want) {
  for (const key of [...held]) if (!want.has(key)) { await page.keyboard.up(key); held.delete(key); }
  for (const key of want) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
}
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

try {
  // The page creates its own arena, so it holds the owner key that spectating requires.
  await page.goto(base);
  await page.waitForFunction(() => window.arenaDebug?.().tick > 2, null, { timeout: 20000 });
  const playerId = await page.evaluate(() => window.arenaDebug().me.id);
  const game = [...server.rooms.values()].find(r => r.started).game;
  const me = () => game.players.find(p => p.id === playerId);
  // Prefer loot the contestant can actually walk to in a straight line: the demo steers directly and
  // has no pathfinder, so a crate behind a building is a crate it will grind against a wall chasing.
  const loot = kind => {
    const self = me(), all = game.map.items.filter(i => i.kind === kind).sort((a, b) => distance(self, a) - distance(self, b));
    return all.find(i => distance(self, i) < 900 && lineClear(game.map, self, i)) ?? all[0];
  };
  const hunter = () => game.players.filter(p => p.role === 'gladiator' && p.status === 'active').sort((a, b) => distance(me(), a) - distance(me(), b))[0];

  // Point the mouse at a world position, accounting for the camera and the HUD strip above the canvas.
  async function aimAt(target) {
    const view = await page.evaluate(() => window.arenaDebug().camera);
    if (!view) return;
    const x = Math.max(4, Math.min(WIDTH - 4, (target.x - view.x) * view.zoom));
    const y = Math.max(HUD_TOP + 4, Math.min(HEIGHT - 4, (target.y - view.y) * view.zoom + HUD_TOP));
    await page.mouse.move(x, y);
  }
  // Walk toward a target, re-reading it each step so a looted crate is replaced by the next one.
  // With no pathfinder, the only way past a wall is to notice we have stopped moving and slide along it.
  async function steer(target, { timeout = 7000, stop = 34, aim = null } = {}) {
    const deadline = Date.now() + timeout;
    let last = me(), lastMoved = Date.now(), slide = 0;
    while (Date.now() < deadline) {
      const self = me(), goal = target();
      if (!self || self.status !== 'active' || !goal) break;
      if (stop > 0 && distance(self, goal) < stop) break;
      if (distance(self, last) > 12) { lastMoved = Date.now(); last = self; }
      else if (Date.now() - lastMoved > 450) { slide = slide ? -slide : (goal.y > self.y ? -1 : 1); lastMoved = Date.now(); }
      const dx = goal.x - self.x, dy = goal.y - self.y, want = new Set();
      if (slide) {
        want.add(slide > 0 ? 'KeyW' : 'KeyS');
        if (Math.abs(dx) > 40) want.add(dx > 0 ? 'KeyD' : 'KeyA');
      } else {
        if (dx > 14) want.add('KeyD'); else if (dx < -14) want.add('KeyA');
        if (dy > 14) want.add('KeyS'); else if (dy < -14) want.add('KeyW');
      }
      await press(want);
      await aimAt(aim?.() ?? goal);
      await page.waitForTimeout(55);
    }
    await press(new Set());
  }
  // Keep trying for a pickup until the counter actually moves or the attempts run out.
  async function collect(kind, counter, attempts = 3, each = 5000) {
    for (let i = 0; i < attempts; i++) {
      if (counter() > 0) return true;
      const goal = loot(kind);
      if (!goal) return false;
      await steer(() => loot(kind), { timeout: each });
      await page.waitForTimeout(200);
    }
    return counter() > 0;
  }

  await aimAt({ x: me().x + 400, y: me().y });
  await page.waitForTimeout(600);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

  // Find a blaster first, so the rest of the clip has something to show, then grab a charge if it is close.
  const armed = await collect('weapon', () => me()?.weapon ?? 0, 3, 5000);
  console.log(`blaster acquired: ${armed}`);
  await collect('access', () => me()?.keys ?? 0, 1, 3500);

  // Push east, firing toward the nearest gladiator when one is around and down the lane otherwise.
  const ahead = () => { const g = hunter(), self = me(); return g && self && distance(self, g) < 900 ? g : { x: (self?.x ?? 0) + 500, y: self?.y ?? 0 }; };
  await page.mouse.down();
  await steer(() => ({ x: me().x + 420, y: me().y - 60 }), { timeout: 3600, stop: 0, aim: ahead });
  await page.mouse.up();
  await page.waitForTimeout(200);

  // Smoke and speed burst, then keep running the lane.
  await page.keyboard.press('KeyQ');
  await steer(() => ({ x: me().x + 500, y: me().y }), { timeout: 2600, stop: 0, aim: ahead });

  // Pull back to the local overview, then hand the camera to the directed view for the closing shot.
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(1500);
  await page.keyboard.press('KeyM');
  await page.waitForTimeout(400);
  try {
    await page.evaluate(() => window.arenaSpectate());
    await page.waitForFunction(() => document.getElementById('connection-text').textContent === 'SPECTATING', null, { timeout: 8000 });
    await page.waitForTimeout(2600);
  } catch (error) { console.warn('directed closing shot skipped:', error.message); }

  await cdp.send('Page.stopScreencast');
  await page.waitForTimeout(200);
  const final = me();
  console.log(`final: blaster ${final?.weapon ?? 0}, charges ${final?.keys ?? 0}, hp ${final?.hp ?? 0}, status ${final?.status}`);
} finally {
  await browser.close();
  await server.close();
}

if (frames.length < 60) throw new Error(`only captured ${frames.length} frames`);
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const file = path.join(frameDir, `f${String(i).padStart(5, '0')}.jpg`);
  await writeFile(file, Buffer.from(frames[i].data, 'base64'));
  const next = frames[i + 1]?.at ?? frames[i].at + 40;
  lines.push(`file '${file.replace(/\\/g, '/')}'`, `duration ${Math.min(0.5, Math.max(0.001, (next - frames[i].at) / 1000)).toFixed(4)}`);
  if (i === frames.length - 1) lines.push(`file '${file.replace(/\\/g, '/')}'`);
}
const list = path.join(frameDir, 'frames.txt');
await writeFile(list, lines.join('\n'));

const mp4 = path.join(outDir, 'last-exit-demo.mp4');
const gif = path.join(outDir, 'last-exit-demo.gif');
const palette = path.join(frameDir, 'palette.png');
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
// The GIF is the README's, so it takes the closing stretch only and stays small enough to embed.
const seconds = (frames.at(-1).at - frames[0].at) / 1000;
const gifFrom = Math.max(0, seconds - 17).toFixed(2);
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-ss', gifFrom, '-i', list, '-vf', 'fps=12,scale=600:-2:flags=lanczos,palettegen=max_colors=128', palette]);
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-ss', gifFrom, '-i', list, '-i', palette, '-lavfi', 'fps=12,scale=600:-2:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', gif]);

console.log(JSON.stringify({ seed, frames: frames.length, seconds: Number(seconds.toFixed(1)), captureFps: Number((frames.length / seconds).toFixed(1)), mp4, gif }, null, 2));
