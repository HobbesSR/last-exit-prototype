import test from 'node:test';
import assert from 'node:assert/strict';
import { ACK_ALONE_MS, createArenaSocketOpener, chooseTransport, createDatagramAssembler, createFrameReader, encodeStreamFrame, forcedTransport, packInputDatagram } from '../public/arena-socket.js';

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
        this.datagramsIn = new TransformStream();
        this.datagrams = { maxDatagramSize, readable: this.datagramsIn.readable, createWritable: () => new WritableStream({ write: chunk => { this.datagramsSent.push(chunk); } }) };
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
const offer = { webTransport: { port: 4433, certificateHash: '0a'.repeat(32) }, webSocket: { port: 4434, tls: false } };
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

test('without a WebTransport offer, or a WebTransport in the browser, the edge WebSocket is used', async () => {
  for (const extra of [
    { fetchConfig: async () => ({ webTransport: null, webSocket: { port: 4434, tls: false } }) },
    { WebTransport: undefined },
  ]) {
    const open = opener({ WebTransport: fakeTransport(), ...extra }), socket = open();
    assert.equal(socket.readyState, 0);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(socket.transport, 'websocket');
    assert.equal(FakeWebSocket.made[0].url, 'ws://arena.test:4434/arena');
  }
  const tlsOpen = opener({ WebTransport: undefined, fetchConfig: async () => ({ webTransport: null, webSocket: { port: 4435, tls: true } }) });
  tlsOpen();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(FakeWebSocket.made[0].url, 'wss://arena.test:4435/arena');

  for (const extra of [
    { fetchConfig: async () => ({ webTransport: null, webSocket: null }) },
    { fetchConfig: async () => { throw new Error('down'); } },
  ]) {
    const socket = opener({ WebTransport: undefined, ...extra })();
    const closed = await next(socket, 'close');
    assert.equal(closed.code, 1006);
    assert.equal(FakeWebSocket.made.length, 0);
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

test('forced modes: ws fetches config once and skips WebTransport; wt never falls back', async () => {
  const Transport = fakeTransport({ opens: false });
  let fetches = 0;
  const fetchConfig = async () => { fetches++; return offer; };
  const forcedWs = opener({ WebTransport: Transport, fetchConfig, location: { ...location, search: '?transport=ws' } })();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(forcedWs.transport, 'websocket'); assert.equal(fetches, 1); assert.equal(Transport.made.length, 0);
  assert.equal(FakeWebSocket.made[0].url, 'ws://arena.test:4434/arena');

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

test('inputs are packed newest last, with as many earlier ones as fit, up to three, beside the acknowledged tick', () => {
  const enc = text => new TextEncoder().encode(text), dec = bytes => bytes && new TextDecoder().decode(bytes);
  const [a, b, c] = ['{"s":1}', '{"s":2}', '{"s":3}'].map(enc);
  assert.equal(dec(packInputDatagram([a, b, c])), '{"inputs":[{"s":1},{"s":2},{"s":3}]}');
  assert.equal(dec(packInputDatagram([c])), '{"inputs":[{"s":3}]}');
  assert.equal(dec(packInputDatagram([b, c], Infinity, 41)), '{"ack":41,"inputs":[{"s":2},{"s":3}]}');
  // Each input costs its bytes and one separator; the head and the closing brace cost thirteen.
  assert.equal(dec(packInputDatagram([a, b, c], 13 + 8 * 2)), '{"inputs":[{"s":2},{"s":3}]}');
  assert.equal(dec(packInputDatagram([a, b, c], 13 + 8)), '{"inputs":[{"s":3}]}');
  assert.equal(packInputDatagram([a, b, c], 13 + 6), null);
  // An idle client acknowledges with no input; with nothing at all there is no datagram.
  assert.equal(dec(packInputDatagram([], Infinity, 41)), '{"ack":41,"inputs":[]}');
  assert.equal(packInputDatagram([]), null);
});

test('over WebTransport, inputs go as datagrams repeating the two before them; a WebSocket or a session without datagrams sends them on the stream', async () => {
  const input = seq => JSON.stringify({ type: 'input', seq, tick: seq });
  const Transport = fakeTransport({ maxDatagramSize: 1200 });
  const socket = opener({ WebTransport: Transport })();
  await next(socket, 'open');
  const wt = Transport.made[0];
  for (let seq = 0; seq < 5; seq++) socket.sendInput(input(seq));
  for (let i = 0; i < 50 && wt.datagramsSent.length < 5; i++) await new Promise(r => setTimeout(r, 2));
  const seqs = wt.datagramsSent.map(bytes => JSON.parse(new TextDecoder().decode(bytes)).inputs.map(m => m.seq));
  assert.deepEqual(seqs, [[0], [0, 1], [0, 1, 2], [1, 2, 3], [2, 3, 4]]);
  // Too large for a datagram: the stream carries it, and later datagrams do not repeat it.
  wt.datagrams.maxDatagramSize = 13 + input(5).length - 1;
  socket.sendInput(input(5));
  wt.datagrams.maxDatagramSize = 1200;
  socket.sendInput(input(6));
  for (let i = 0; i < 50 && (wt.datagramsSent.length < 6 || !wt.sent.length); i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual([...wt.sent[0]], [...frame(0, Buffer.from(input(5)))]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(wt.datagramsSent[5])).inputs.map(m => m.seq), [3, 4, 6]);

  const plain = fakeTransport(), streamed = opener({ WebTransport: plain })();
  await next(streamed, 'open');
  streamed.sendInput(input(0));
  for (let i = 0; i < 50 && !plain.made[0].sent.length; i++) await new Promise(r => setTimeout(r, 2));
  assert.deepEqual([...plain.made[0].sent[0]], [...frame(0, Buffer.from(input(0)))]);

  const ws = opener({ WebTransport: undefined })();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(ws.transport, 'websocket');
  assert.equal(ws.sendInput, ws.send);
  // Closed at once, so it never falls back to a WebSocket that a later test would count.
  const opening = opener({ WebTransport: fakeTransport({ opens: false }) })();
  assert.throws(() => opening.sendInput('x'), /not open/);
  opening.close(); ws.close(); streamed.close(); socket.close();
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

/** The edge's fragments of `message` under `number` (24.5 "Delivery"), each 4 header bytes and up to `size` bytes. */
const fragments = (number, message, size = 1100) => {
  const count = Math.ceil(message.length / size);
  return Array.from({ length: count }, (_, i) => Uint8Array.of(number >> 8, number & 255, i, count, ...message.subarray(i * size, (i + 1) * size)));
};

test("the edge's fragments are rebuilt in any order; a repeated, malformed or abandoned fragment is ignored", () => {
  const assemble = createDatagramAssembler(2);
  const message = Uint8Array.from({ length: 3000 }, (_, i) => i % 251);
  const [a, b, c] = fragments(7, message);
  assert.deepEqual(assemble(fragments(6, Uint8Array.of(9))[0]), Uint8Array.of(9), 'one fragment is the message');
  assert.equal(assemble(c), null);
  assert.equal(assemble(c), null, 'a repeat');
  assert.equal(assemble(a), null);
  assert.deepEqual(assemble(b), message);
  assert.equal(assemble(Uint8Array.of(0, 1, 0, 5, 1)), null, 'more than four fragments');
  assert.equal(assemble(Uint8Array.of(0, 1, 2, 2, 1)), null, 'an index past the count');
  assert.equal(assemble(Uint8Array.of(0, 1, 0, 1)), null, 'no payload');
  // Only the newest two incomplete messages are kept: message 1, which lost a fragment, is forgotten.
  const [first] = fragments(1, message), [, second] = fragments(2, message), [third] = fragments(3, message);
  for (const part of [first, second, third]) assert.equal(assemble(part), null);
  assert.equal(assemble(fragments(1, message)[1]), null, 'message 1 starts again');
  // Wrapping numbers: a message left incomplete is forgotten once single-fragment ones move past it, so the
  // same number coming round again starts afresh rather than completing with the old fragment.
  const wrap = createDatagramAssembler(2), [left] = fragments(10, message);
  assert.equal(wrap(left), null);
  for (const n of [11, 12, 13]) assert.deepEqual(wrap(fragments(n, Uint8Array.of(n))[0]), Uint8Array.of(n));
  const other = Uint8Array.from({ length: 3000 }, () => 1), [, b2, c2] = fragments(10, other);
  assert.equal(wrap(b2), null);
  assert.equal(wrap(c2), null, 'without the forgotten fragment it stays incomplete');
});

test('over WebTransport, server datagrams arrive as binary messages, and acknowledgements ride inputs or go alone when idle', async () => {
  const Transport = fakeTransport({ maxDatagramSize: 1200 });
  const socket = opener({ WebTransport: Transport })();
  socket.binaryType = 'arraybuffer';
  await next(socket, 'open');
  const wt = Transport.made[0], writer = wt.datagramsIn.writable.getWriter();
  const message = Uint8Array.from({ length: 2500 }, (_, i) => i % 13);
  const arrived = next(socket, 'message');
  for (const part of fragments(0, message).reverse()) await writer.write(part);
  assert.deepEqual(new Uint8Array((await arrived).data), message);

  const sent = () => wt.datagramsSent.map(bytes => JSON.parse(new TextDecoder().decode(bytes)));
  const settle = async count => { for (let i = 0; i < 50 && wt.datagramsSent.length < count; i++) await new Promise(r => setTimeout(r, 2)); };
  // Idle: the acknowledgement goes alone, once per tick acknowledged.
  socket.acknowledge(40);
  socket.acknowledge(40);
  await settle(1);
  assert.deepEqual(sent(), [{ ack: 40, inputs: [] }]);
  // Active: an input just went, so the next acknowledgement waits for the next input.
  socket.sendInput(JSON.stringify({ type: 'input', seq: 1, tick: 41 }));
  socket.acknowledge(41);
  socket.sendInput(JSON.stringify({ type: 'input', seq: 2, tick: 42 }));
  await settle(3);
  assert.deepEqual(sent().map(d => [d.ack, d.inputs.map(m => m.seq)]), [[40, []], [40, [1]], [41, [1, 2]]]);
  await new Promise(r => setTimeout(r, ACK_ALONE_MS + 10));
  socket.acknowledge(42);
  await settle(4);
  assert.deepEqual(sent().at(-1), { ack: 42, inputs: [] });
  socket.close();
});
