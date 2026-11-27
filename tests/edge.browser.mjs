import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { spawnEdge } from './helpers/edge.js';
import { startLossyRelay } from './helpers/lossy-relay.js';

// The Rust edge end to end (#1095, #1207, 24.5 stages 1 to 4): `last-exit-edge`, linked to this server,
// carries both WebTransport and WebSocket Chrome sessions behind the session seam. A room cannot tell the
// transport, so the default room's join, start and walk must work on both. On WebTransport the player's match
// frames come as `fast` datagrams the page rebuilds and acknowledges, so the walk is drawn from them. The page
// reaches the edge through a UDP relay, which later loses datagrams: the page keeps drawing through loss and
// recovers from an outage longer than the 32-tick history with whole frames. Needs the Rust toolchain: the edge
// is built first.
const replayDir = await mkdtemp(path.join(tmpdir(), 'last-exit-edge-'));
const { server, base, browser, close } = await serveWithBrowser({ profileSummary: false, roomThreads: false, edgeLink: 0, edge: false, replayDir });
const edge = await spawnEdge(server, { stdio: ['ignore', 'inherit', 'inherit'] });
const errors = [];
let relay = null;
try {
  // The edge reports its WebTransport and WebSocket ports over the link, and the page learns them from client config.
  const config = await (await fetch(`${base}/api/client-config`)).json();
  const offer = config.webTransport, wsOffer = config.webSocket;
  assert.ok(offer?.port && /^[0-9a-f]{64}$/.test(offer.certificateHash), 'the linked edge is offered with its certificate hash');
  assert.ok(wsOffer?.port && wsOffer.tls === false, 'the linked edge also offers plain WebSocket in dev');

  // Forced WebTransport never falls back, so a match that starts and moves proves the edge carried it. The page
  // learns the edge from the client config, which points it at the relay; lossless, the relay only forwards.
  relay = await startLossyRelay({ target: offer.port, profile: { rtt: 0, jitter: 0, loss: 0 }, seed: 1095 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  collectBrowserErrors(page, errors, { consoleErrors: true });
  await page.route('**/api/transport', async route => {
    const response = await route.fetch(), transport = await response.json();
    await route.fulfill({ response, json: { ...transport, webTransport: { ...transport.webTransport, port: relay.port } } });
  });
  await page.goto(`${base}/?seed=4217&transport=wt`);
  const start = page.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  const room = new URL(page.url()).searchParams.get('room');
  await start.click();
  await page.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  const before = await page.evaluate(() => window.arenaDebug().me.x);
  await page.keyboard.down('KeyD'); await page.waitForTimeout(650); await page.keyboard.up('KeyD');
  await page.waitForFunction(x => window.arenaDebug().me.x > x + 40, before, { timeout: 5000 });
  // Stage 2: the walk's inputs rode datagrams, Chrome's real ones through the edge, not the stream.
  assert.ok(server.edgeLink.counts().datagrams > 10, `inputs arrived as datagrams (${JSON.stringify(server.edgeLink.counts())})`);
  // Stage 3: the match's fast state went as datagrams, and Chrome acknowledged the frames it rebuilt, so the
  // server could send deltas. The walk above was drawn from them: a player session is sent no match `state`.
  const tick = await page.evaluate(() => window.arenaDebug().tick);
  await page.waitForFunction(at => window.arenaDebug().tick > at + 10, tick, { timeout: 5000 });
  const counts = server.edgeLink.counts();
  assert.ok(counts.sends > 20 && counts.acks > 10, `fast state went as datagrams and was acknowledged (${JSON.stringify(counts)})`);

  // Under loss (24.5 "Stage 3's contracts"): each fast datagram the player's session sends is noted, delta or whole,
  // as the room decides (a delta when the acknowledged frame is in the session's history).
  const live = server.rooms.get(room), client = [...live.clients].find(c => c.playerId), datagram = client.datagram;
  const sent = [];
  client.datagram = bytes => {
    sent.push(client.fastAck !== null && client.fastAck !== undefined && !!client.fastHistory?.get(client.fastAck) ? 'delta' : 'whole');
    return datagram(bytes);
  };
  const drawnTick = () => page.evaluate(() => window.arenaDebug().buffer.newest);
  // A fifth of the packets lost each way: frames keep being drawn, from deltas against what the page acknowledged.
  await relay.update({ rtt: 0, jitter: 0, loss: 0.2 });
  const lossyFrom = await drawnTick();
  await page.waitForTimeout(2000);
  const lossy = await relay.counts(), lossyDrawn = await drawnTick() - lossyFrom;
  assert.ok(lossy.downDropped > 5, `the relay lost datagrams (${JSON.stringify(lossy)})`);
  assert.ok(lossyDrawn > 20, `frames kept being drawn through loss (${lossyDrawn} ticks in 2 s)`);
  assert.ok(sent.filter(kind => kind === 'delta').length > sent.length / 2, `deltas carried the lossy stretch (${sent.join(',')})`);
  // An outage longer than the history: the page's acknowledged frame ages out, so the room sends whole frames until
  // one arrives and is acknowledged; then deltas resume and the page draws the current tick again.
  await relay.update({ rtt: 0, jitter: 0, loss: 1 });
  await page.waitForTimeout(2500);
  const stalled = await drawnTick();
  sent.length = 0;
  await relay.update({ rtt: 0, jitter: 0, loss: 0 });
  await page.waitForFunction(at => window.arenaDebug().buffer.newest > at + 10, stalled, { timeout: 5000 });
  // The first whole frame jumps the page past the outage at once; deltas follow once its acknowledgement lands.
  for (let waited = 0; !sent.includes('delta') && waited < 3000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  const firstDelta = sent.indexOf('delta');
  assert.ok(sent[0] === 'whole' && firstDelta > 0, `recovery began whole and deltas resumed (${sent.join(',')})`);
  assert.ok(live.match.tick - await drawnTick() < 5, 'the page draws the current tick again');
  client.datagram = datagram;

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

  // Forced WebSocket (`?transport=ws`) also routes through the Rust edge on its separate WS port.
  const wsWatcher = await browser.newPage();
  collectBrowserErrors(wsWatcher, errors, { consoleErrors: true });
  await wsWatcher.goto(`${base}/?room=${room}&mode=spectator&transport=ws`);
  const wsUsed = await wsWatcher.evaluate(async () => {
    const { openArenaSocket } = await import('/arena-socket.js');
    const socket = openArenaSocket();
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('close', reject); });
    const transport = socket.transport; socket.close(); return transport;
  });
  assert.equal(wsUsed, 'websocket', 'forced WebSocket connects through the edge');
  await wsWatcher.close();

  // Nothing went wrong while the edge was up.
  assert.deepEqual(errors, []);
  // The edge going away withdraws both offers; the room outlives it. The pages whose sessions it carried
  // may report the lost connection, and only that.
  const sinceKill = errors.length;
  await edge.stop();
  let withdrawn = false;
  for (let i = 0; i < 100 && !withdrawn; i++) {
    const after = await (await fetch(`${base}/api/client-config`)).json();
    withdrawn = after.webTransport === null && after.webSocket === null;
    if (!withdrawn) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(withdrawn, 'a lost edge withdraws both WebTransport and WebSocket offers');
  assert.equal(server.rooms.has(room), true, 'the room outlives the edge');
  assert.deepEqual(errors.slice(sinceKill).filter(text => !/WebTransport|ERR_QUIC|net::/.test(text)), []);
  console.log('edge browser check passed');
} finally {
  await relay?.stop();
  await edge.stop();
  try { await close(); } finally { await rm(replayDir, { recursive: true, force: true }); }
}
