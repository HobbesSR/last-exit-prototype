import assert from 'node:assert/strict';
import { collectBrowserErrors, serveWithBrowser } from './helpers/browser.js';
import { roomHarness } from './helpers/room-harness.js';
import { wireCodec } from '../shared/wire-schema.ts';

// The descriptor codec in Chrome (#1131 stage 1): the browser's reader, as public/room-connection.js loads it,
// decodes Node's bytes for a room's live state messages to exactly what JSON gives, and its encoder writes
// the same bytes as Node's. The Node side's round trip and refusals are tests/wire-codec.test.js.
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

const { base, browser, close } = await serveWithBrowser({ profileSummary: false, roomThreads: false });
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
  assert.deepEqual(errors, []);
  console.log(`Descriptor codec browser checks passed: ${messages.length} messages`);
  await page.close();
} finally { await close(); }
