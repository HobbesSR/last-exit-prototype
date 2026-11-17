import assert from 'node:assert/strict';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { reusedMap, roomHarness } from './helpers/room-harness.js';
import { wireCodec } from '../shared/wire-schema.ts';

// The descriptor codec in Chrome (#1131 stage 1): the browser's reader, as public/room-connection.js loads it,
// decodes Node's bytes for a room's live state messages to exactly what JSON gives, and its encoder writes
// the same bytes as Node's. Then the client plays a match on binary state, and refuses bytes it cannot read. The Node side's round trip and refusals are tests/wire-codec.test.js.
const h = roomHarness({ reuseMaps: true }), made = await h.room();
const owner = h.joined(made, { ownerKey: made.ownerKey }), other = h.joined(made, { role: 'gladiator' });
let messages;
try {
  for (let i = 0; i < 3; i++) h.wake(50);
  owner.send({ type: 'start' });
  for (let i = 0; i < 60; i++) h.wake(50);
  messages = [owner, other].flatMap(p => p.rawMessages.filter(m => m.type === 'state'));
} finally { await h.service.close(); }
const codec = wireCodec(), encoded = messages.map(m => Array.from(codec.encode(m)));

// Rooms play the pregenerated arena (seed 9's map, `reusedMap`): this is about the wire, not generation.
const { base, browser, close } = await serveWithBrowser({ profileSummary: false, roomThreads: false, generateMap: reusedMap });
const errors = [];
try {
  const page = await browser.newPage();
  collectBrowserErrors(page, errors, { consoleErrors: true });
  await page.goto(base);
  const result = await page.evaluate(async encoded => {
    const { readServerMessage, wireCodec } = await import('/shared/wire-schema.ts');
    const decoded = encoded.map(bytes => readServerMessage(Uint8Array.from(bytes).buffer));
    const reencoded = decoded.map(message => Array.from(wireCodec().encode(message)));
    return { decoded, reencoded };
  }, encoded);
  assert.equal(result.decoded.length, messages.length);
  for (let i = 0; i < messages.length; i++) {
    assert.deepEqual(result.decoded[i], messages[i], `message ${i} decodes in Chrome as JSON gives it`);
    assert.deepEqual(result.reencoded[i], encoded[i], `message ${i} encodes to the same bytes in Chrome`);
  }
  await page.close();

  // The real client on binary state (public/room-connection.js): the server still sends JSON in stage 1, so a
  // routed socket re-encodes each of its state messages as D. The client plays a match on them, and a
  // message it cannot read then ends the connection with a notice rather than being guessed at.
  const live = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  collectBrowserErrors(live, errors, { consoleErrors: true });
  const routed = []; let binary = 0;
  await live.routeWebSocket(/./, ws => {
    const server = ws.connectToServer();
    server.onMessage(message => {
      const data = typeof message === 'string' ? JSON.parse(message) : null;
      if (data?.type === 'state') { binary++; ws.send(Buffer.from(codec.encode(data))); } else ws.send(message);
    });
    ws.onMessage(message => server.send(message));
    routed.push(ws);
  });
  await live.goto(`${base}/?seed=9`);
  const start = live.getByRole('button', { name: 'Start match', exact: true });
  await start.waitFor({ state: 'visible', timeout: 60000 });
  await start.click();
  await live.waitForFunction(() => window.arenaDebug().phase === 'live' && window.arenaDebug().me?.id, null, { timeout: 120000 });
  const before = await live.evaluate(() => window.arenaDebug().me.x);
  await live.keyboard.down('KeyD'); await live.waitForTimeout(650); await live.keyboard.up('KeyD');
  await live.waitForFunction(x => window.arenaDebug().me.x > x + 40, before, { timeout: 5000 });
  // Every state message reached the client as D (the route converts each one), and it walked on them.
  assert.ok(binary > 0, `the client played on ${binary} binary state messages`);
  routed.at(-1).send(Buffer.from('{"type":"state"}'));
  await live.getByText('The arena sent a message this browser cannot read.').waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
  console.log(`Descriptor codec browser checks passed: ${messages.length} messages; the client played on ${binary} binary frames`);
  await live.close();
} finally { await close(); }
