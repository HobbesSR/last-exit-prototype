import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';

// The WebTransport edge end to end (#1095, 24.5 stage 1): the Rust edge, linked to this server, carries a real
// Chrome session behind the session seam. A room cannot tell the transport, so the default room's join, start and
// walk must work on WebTransport as they do on the WebSocket. Needs the Rust toolchain: the edge is built first.
const RUST = path.resolve('rust');
execFileSync('cargo', ['build', '--locked', '-p', 'last-exit-edge'], { cwd: RUST, stdio: 'inherit' });
const binary = path.join(RUST, 'target', 'debug', process.platform === 'win32' ? 'last-exit-edge.exe' : 'last-exit-edge');

const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-edge-'));
const { server, base, browser, close } = await serveWithBrowser({ profileSummary: false, roomThreads: false, edgeLink: 0, replayDir });
const edge = spawn(binary, ['--link', `127.0.0.1:${server.edgeLink.port}`, '--port', '0'], { stdio: ['ignore', 'inherit', 'inherit'] });
const errors = [];
try {
  // The edge reports its port and certificate over the link, and the page learns them from the client config.
  let offer = null;
  for (let i = 0; i < 100 && !offer; i++) {
    offer = (await (await fetch(`${base}/api/client-config`)).json()).webTransport;
    if (!offer) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(offer?.port && /^[0-9a-f]{64}$/.test(offer.certificateHash), 'the linked edge is offered with its certificate hash');

  // Forced WebTransport never falls back, so a match that starts and moves proves the edge carried it.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  collectBrowserErrors(page, errors, { consoleErrors: true });
  await page.goto(`${base}/?seed=4217&transport=wt`);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  const room = new URL(page.url()).searchParams.get('room');
  await start.click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  const before = await page.evaluate(() => window.arenaDebug().me.x);
  await page.keyboard.down('KeyD'); await page.waitForTimeout(650); await page.keyboard.up('KeyD');
  await page.waitForFunction(x => window.arenaDebug().me.x > x + 40, before, { timeout: 5000 });

  // Unforced, the page chooses WebTransport too. Its spectator join reaches the same room through the edge.
  const watcher = await browser.newPage();
  collectBrowserErrors(watcher, errors, { consoleErrors: true });
  await watcher.goto(`${base}/?room=${room}&mode=spectator`);
  const used = await watcher.evaluate(async () => {
    const { openArenaSocket } = await import('/arena-socket.js');
    const socket = openArenaSocket();
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('close', reject); });
    const transport = socket.transport; socket.close(); return transport;
  });
  assert.equal(used, 'webtransport', 'an unforced socket chooses WebTransport when the edge is offered');

  // Nothing went wrong while the edge was up.
  assert.deepEqual(errors, []);
  // The edge going away withdraws the offer, so later pages use the WebSocket; the room outlives it. The pages
  // whose sessions it carried may report the lost connection, and only that.
  const sinceKill = errors.length;
  edge.kill();
  let withdrawn = false;
  for (let i = 0; i < 100 && !withdrawn; i++) {
    withdrawn = (await (await fetch(`${base}/api/client-config`)).json()).webTransport === null;
    if (!withdrawn) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(withdrawn, 'a lost edge is no longer offered');
  assert.equal(server.rooms.has(room), true, 'the room outlives the edge');
  assert.deepEqual(errors.slice(sinceKill).filter(text => !/WebTransport|ERR_QUIC|net::/.test(text)), []);
  console.log('edge browser check passed');
} finally {
  edge.kill();
  try { await close(); } finally { await rm(replayDir, { recursive: true, force: true }); }
}
