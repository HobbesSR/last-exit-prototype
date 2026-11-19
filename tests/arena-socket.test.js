import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaSocketOpener, chooseTransport, createFrameReader, encodeStreamFrame, forcedTransport, packInputDatagram } from '../public/arena-socket.js';

// The browser socket's choice, fallback and framing, with a fake WebSocket and WebTransport: no browser.

const next = (target, type) => new Promise(resolve => target.addEventListener(type, resolve, { once: true }));

class FakeWebSocket extends EventTarget {
  static made = [];
  constructor(url) { super(); this.url = url; this.bufferedAmount = 0; FakeWebSocket.made.push(this); }
  close() {}
}

/**
 * A WebTransport whose session and stream open at once, or never. With `maxDatagramSize`, it has datagrams, and
 * the ones written are kept in `datagramsSent`.
 */
function fakeTransport({ opens = true, maxDatagramSize = null } = {}) {
  const made = [];
  return class {
    constructor(url, options) {
      this.url = url; this.options = options; made.push(this);
      this.inbound = new TransformStream(); this.sent = [];
      this.ready = opens ? Promise.resolve() : new Promise(() => {});
      this.closed = new Promise(resolve => { this.end = resolve; });
      this.closeCalls = []; this.datagramsSent = [];
      if (maxDatagramSize !== null) {
        this.datagrams = { maxDatagramSize, createWritable: () => new WritableStream({ write: chunk => { this.datagramsSent.push(chunk); } }) };
      }
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

test('inputs are packed newest last, with as many earlier ones as fit, up to three', () => {
  const enc = text => new TextEncoder().encode(text), dec = bytes => bytes && new TextDecoder().decode(bytes);
  const [a, b, c] = ['{"s":1}', '{"s":2}', '{"s":3}'].map(enc);
  assert.equal(dec(packInputDatagram([a, b, c])), '[{"s":1},{"s":2},{"s":3}]');
  assert.equal(dec(packInputDatagram([c])), '[{"s":3}]');
  // Each input costs its bytes and one separator; the brackets cost two.
  assert.equal(dec(packInputDatagram([a, b, c], 2 + 7 * 2 + 1)), '[{"s":2},{"s":3}]');
  assert.equal(dec(packInputDatagram([a, b, c], 9)), '[{"s":3}]');
  assert.equal(packInputDatagram([a, b, c], 8), null);
});

test('over WebTransport, inputs go as datagrams repeating the two before them; a WebSocket or a session without datagrams sends them on the stream', async () => {
  const input = seq => JSON.stringify({ type: 'input', seq, tick: seq });
  const Transport = fakeTransport({ maxDatagramSize: 1200 });
  const socket = opener({ WebTransport: Transport })();
  await next(socket, 'open');
  const wt = Transport.made[0];
  for (let seq = 0; seq < 5; seq++) socket.sendInput(input(seq));
  for (let i = 0; i < 50 && wt.datagramsSent.length < 5; i++) await new Promise(r => setTimeout(r, 2));
  const seqs = wt.datagramsSent.map(bytes => JSON.parse(new TextDecoder().decode(bytes)).map(m => m.seq));
  assert.deepEqual(seqs, [[0], [0, 1], [0, 1, 2], [1, 2, 3], [2, 3, 4]]);
  // Too large for a datagram: the stream carries it, and later datagrams do not repeat it.
  wt.datagrams.maxDatagramSize = 2 + input(5).length - 1;
  socket.sendInput(input(5));
  wt.datagrams.maxDatagramSize = 1200;
  socket.sendInput(input(6));
  for (let i = 0; i < 50 && (wt.datagramsSent.length < 6 || !wt.sent.length); i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual([...wt.sent[0]], [...frame(0, Buffer.from(input(5)))]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(wt.datagramsSent[5])).map(m => m.seq), [3, 4, 6]);

  const plain = fakeTransport(), streamed = opener({ WebTransport: plain })();
  await next(streamed, 'open');
  streamed.sendInput(input(0));
  for (let i = 0; i < 50 && !plain.made[0].sent.length; i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual([...plain.made[0].sent[0]], [...frame(0, Buffer.from(input(0)))]);

  const ws = opener({ WebTransport: undefined })();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(ws.transport, 'websocket');
  assert.equal(ws.sendInput, ws.send);
  assert.throws(() => opener({ WebTransport: fakeTransport({ opens: false }) })().sendInput('x'), /not open/);
});

test('closing while WebTransport is opening abandons the session at once, with one close and no error', async () => {
  const Transport = fakeTransport({ opens: false });
  const socket = opener({ WebTransport: Transport, location: { ...location, search: '?transport=wt' } })();
  const events = []; for (const type of ['open', 'error', 'close']) socket.addEventListener(type, () => events.push(type));
  for (let i = 0; i < 50 && !Transport.made.length; i++) await new Promise(r => setTimeout(r, 2));
  socket.close();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events, ['close']);
  assert.equal(Transport.made[0].closeCalls.length, 1, 'the opening session was closed, not left to finish');

  // Closed before the config even answered: no WebTransport is made at all.
  let answer; const late = opener({ WebTransport: Transport, fetchConfig: () => new Promise(resolve => { answer = resolve; }) })();
  late.close(); await new Promise(r => setTimeout(r, 1)); answer(offer); await new Promise(r => setTimeout(r, 10));
  assert.equal(Transport.made.length, 1); assert.equal(FakeWebSocket.made.length, 0);
});

test('a failed WebTransport asks for the config again, so a restarted edge\'s new certificate is learned', async () => {
  let fetches = 0;
  const open = opener({ WebTransport: fakeTransport({ opens: false }), fetchConfig: async () => { fetches++; return offer; } });
  open(); await new Promise(r => setTimeout(r, 60));
  open(); await new Promise(r => setTimeout(r, 5));
  assert.equal(fetches, 1, 'the fallen-back page does not need it');
  const Stalled = fakeTransport({ opens: false });
  const forced = opener({ WebTransport: Stalled, timeoutMs: 20, fetchConfig: async () => { fetches++; return offer; },
    location: { ...location, search: '?transport=wt' } });
  const first = forced();
  for (let i = 0; i < 50 && !Stalled.made.length; i++) await new Promise(r => setTimeout(r, 2));
  first.close(); await new Promise(r => setTimeout(r, 5));
  forced(); await new Promise(r => setTimeout(r, 5));
  assert.equal(fetches, 3, 'after an abandoned attempt, the next socket fetches afresh');
});

test('binary messages are Blobs unless an ArrayBuffer is asked for, as on a WebSocket', async () => {
  const Transport = fakeTransport();
  const socket = opener({ WebTransport: Transport })();
  await next(socket, 'open');
  const got = next(socket, 'message');
  await Transport.made[0].inbound.writable.getWriter().write(frame(1, Uint8Array.of(5)));
  const { data } = await got;
  assert.ok(data instanceof Blob); assert.deepEqual([...new Uint8Array(await data.arrayBuffer())], [5]);
});
