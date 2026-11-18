import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaSocketOpener, chooseTransport, createFrameReader, encodeStreamFrame, forcedTransport } from '../public/arena-socket.js';

// The browser socket's choice, fallback and framing, with a fake WebSocket and WebTransport: no browser.

const next = (target, type) => new Promise(resolve => target.addEventListener(type, resolve, { once: true }));

class FakeWebSocket extends EventTarget {
  static made = [];
  constructor(url) { super(); this.url = url; this.bufferedAmount = 0; FakeWebSocket.made.push(this); }
  close() {}
}

/** A WebTransport whose session and stream open when `go()` is called, or never. */
function fakeTransport({ opens = true } = {}) {
  const made = [];
  return class {
    constructor(url, options) {
      this.url = url; this.options = options; made.push(this);
      this.inbound = new TransformStream(); this.sent = [];
      this.ready = opens ? Promise.resolve() : new Promise(() => {});
      this.closed = new Promise(resolve => { this.end = resolve; });
      this.closeCalls = [];
    }
    async createBidirectionalStream() {
      return { readable: this.inbound.readable, writable: new WritableStream({ write: chunk => { this.sent.push(chunk); } }) };
    }
    close(info) { this.closeCalls.push(info); this.end(info ?? {}); }
    static made = made;
  };
}

const location = { hostname: 'arena.test', host: 'arena.test:3100', protocol: 'http:', search: '' };
const offer = { webTransport: { port: 4433, certificateHash: '0a'.repeat(32) } };
const opener = (extra = {}) => { FakeWebSocket.made = []; return createArenaSocketOpener({ location, WebSocket: FakeWebSocket, timeoutMs: 20, fetchConfig: async () => offer, ...extra }); };
const frame = (flag, bytes) => { const out = new Uint8Array(5 + bytes.length); new DataView(out.buffer).setUint32(0, 1 + bytes.length); out[4] = flag; out.set(bytes, 5); return out; };

test('the choice: config and browser support, a prior fallback, and the forcing flag', () => {
  const base = { forced: null, webTransport: { port: 1 }, available: true, fellBack: false };
  assert.equal(chooseTransport(base), 'wt');
  assert.equal(chooseTransport({ ...base, webTransport: null }), 'ws');
  assert.equal(chooseTransport({ ...base, available: false }), 'ws');
  assert.equal(chooseTransport({ ...base, fellBack: true }), 'ws');
  assert.equal(chooseTransport({ ...base, forced: 'ws' }), 'ws');
  assert.equal(chooseTransport({ ...base, forced: 'wt', webTransport: null, fellBack: true }), 'wt');
  assert.deepEqual(['?transport=ws', '?transport=wt', '?transport=x', ''].map(forcedTransport), ['ws', 'wt', null, null]);
});

test('frames are length-prefixed with a text/binary flag, and read back across any chunking', () => {
  const text = encodeStreamFrame('{"é":1}'), binary = encodeStreamFrame(Uint8Array.of(1, 2, 3));
  assert.deepEqual([...binary], [0, 0, 0, 4, 1, 1, 2, 3]);
  assert.equal(text[4], 0);
  const all = Uint8Array.from([...text, ...binary]), read = createFrameReader(), got = [];
  for (const byte of all) got.push(...read(Uint8Array.of(byte)));
  assert.deepEqual(got.map(f => [f.binary, f.payload.length]), [[false, Buffer.byteLength('{"é":1}')], [true, 3]]);
  assert.equal(createFrameReader()(all).length, 2);
  assert.throws(() => createFrameReader()(Uint8Array.of(0, 0, 0, 0, 0)), /Malformed/);
});

test('without an offer, or a WebTransport in the browser, the WebSocket is used', async () => {
  for (const extra of [{ fetchConfig: async () => ({ webTransport: null }) }, { fetchConfig: async () => { throw new Error('down'); } },
    { WebTransport: undefined }]) {
    const open = opener({ WebTransport: fakeTransport(), ...extra }), socket = open();
    assert.equal(socket.readyState, 0);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(socket.transport, 'websocket');
    assert.equal(FakeWebSocket.made[0].url, 'ws://arena.test:3100');
  }
});

test('a WebTransport that never opens falls back after the timeout, and the page then stays on the WebSocket', async () => {
  const Transport = fakeTransport({ opens: false });
  let fetches = 0;
  const open = opener({ WebTransport: Transport, fetchConfig: async () => { fetches++; return offer; } });
  const first = open(), opened = next(first, 'open');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(first.transport, 'websocket');
  assert.equal(Transport.made.length, 1);
  assert.equal(Transport.made[0].url, 'https://arena.test:4433/arena');
  assert.deepEqual(Transport.made[0].options.serverCertificateHashes[0], { algorithm: 'sha-256', value: Uint8Array.from({ length: 32 }, () => 0x0a) });
  assert.ok(Transport.made[0].closeCalls.length, 'the stalled session was closed');
  FakeWebSocket.made[0].dispatchEvent(new Event('open'));
  await opened; assert.equal(first.readyState, 1);

  const second = open(); await new Promise(r => setTimeout(r, 5));
  assert.equal(second.transport, 'websocket');
  assert.equal(Transport.made.length, 1, 'no second WebTransport attempt');
  assert.equal(fetches, 1, 'the config is fetched once per page');
});

test('forced modes: ws never asks for the config; wt never falls back', async () => {
  const Transport = fakeTransport({ opens: false });
  let fetches = 0;
  const fetchConfig = async () => { fetches++; return offer; };
  const forcedWs = opener({ WebTransport: Transport, fetchConfig, location: { ...location, search: '?transport=ws' } })();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(forcedWs.transport, 'websocket'); assert.equal(fetches, 0); assert.equal(Transport.made.length, 0);

  const forcedWt = opener({ WebTransport: Transport, fetchConfig, location: { ...location, search: '?transport=wt' } })();
  await new Promise(r => setTimeout(r, 60));
  assert.equal(Transport.made.length, 1);
  assert.equal(forcedWt.transport, null, 'still waiting, past the fallback time, with no WebSocket made');
  assert.equal(FakeWebSocket.made.length, 0);

  const noBrowser = opener({ WebTransport: undefined, location: { ...location, search: '?transport=wt' } })();
  const closed = await next(noBrowser, 'close');
  assert.equal(closed.code, 1006); assert.equal(FakeWebSocket.made.length, 0);
});

test('over WebTransport: open, text and binary messages, framed sends, backlog, and the session\'s close info', async () => {
  const Transport = fakeTransport();
  const socket = opener({ WebTransport: Transport })();
  socket.binaryType = 'arraybuffer';
  await next(socket, 'open');
  assert.equal(socket.transport, 'webtransport'); assert.equal(socket.readyState, 1);
  const wt = Transport.made[0], writer = wt.inbound.writable.getWriter();

  const messages = []; socket.addEventListener('message', e => messages.push(e.data));
  const whole = Uint8Array.from([...frame(0, Buffer.from('{"type":"welcome"}')), ...frame(1, Uint8Array.of(7, 8))]);
  await writer.write(whole.subarray(0, 6)); await writer.write(whole.subarray(6));
  for (let i = 0; i < 50 && messages.length < 2; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(messages[0], '{"type":"welcome"}');
  assert.ok(messages[1] instanceof ArrayBuffer); assert.deepEqual([...new Uint8Array(messages[1])], [7, 8]);

  socket.send('{"type":"join"}');
  assert.ok(socket.bufferedAmount >= 0);
  for (let i = 0; i < 50 && !wt.sent.length; i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual([...wt.sent[0]], [...frame(0, Buffer.from('{"type":"join"}'))]);
  await new Promise(r => setTimeout(r, 5)); assert.equal(socket.bufferedAmount, 0);

  const closed = next(socket, 'close');
  wt.end({ closeCode: 1008, reason: 'Invalid message' });
  const event = await closed;
  assert.deepEqual([event.code, event.reason, socket.readyState], [1008, 'Invalid message', 3]);
  assert.throws(() => socket.send('x'), /not open/);
});
