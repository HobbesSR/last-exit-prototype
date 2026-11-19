import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachEdgeLink, encodeFrame, FRAME, LINK_VERSION } from '../server/edge-link.js';
import { createArenaServer } from '../server/index.js';
import { MAX_BUFFERED_BYTES, MAX_MESSAGE_BYTES, MAX_MESSAGES_PER_SECOND, CLOSE_CODE, CLOSE_REASON } from '../server/protocol.js';
import { listen } from './helpers/listen.js';

// A fake edge over a real loopback socket against a stub service: the link's framing and session contract,
// with no Rust and no rooms.

const json = value => Buffer.from(JSON.stringify(value));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const waitFor = async (condition, what) => {
  for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
};

function stubService() {
  const peers = [], received = [], disconnected = [], acks = [];
  return {
    peers, received, disconnected, acks,
    connect: peer => { const session = { id: peers.length, peer }; peers.push(session); return session; },
    receive: (session, data) => received.push([session.id, data]),
    acknowledge: (session, tick) => acks.push([session.id, tick]),
    disconnect: session => disconnected.push(session.id),
  };
}

/** The edge's side of the link: connects, collects frames, and sends them. */
async function fakeEdge(port) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  const frames = []; let buf = Buffer.alloc(0), closed = false;
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const length = buf.readUInt32BE(0);
      frames.push({ type: buf[4], body: buf.subarray(5, 4 + length) });
      buf = buf.subarray(4 + length);
    }
  });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => {});
  return {
    socket, frames, get closed() { return closed; },
    send: (type, ...parts) => socket.write(encodeFrame(type, ...parts)),
    hello: (fields = {}) => socket.write(encodeFrame(FRAME.EDGE, json({ link: LINK_VERSION, port: 4433, certificateHash: 'ab'.repeat(32), validUntil: 1, ...fields }))),
    next: async type => { await waitFor(() => frames.some(f => f.type === type), `frame ${type}`); return frames.splice(frames.findIndex(f => f.type === type), 1)[0]; },
    end: () => socket.destroy(),
  };
}

async function started(t, httpPort = 3333) {
  const service = stubService();
  const link = attachEdgeLink({ service, port: 0, httpPort: () => httpPort });
  await link.listening;
  const edges = [];
  t.after(async () => { for (const e of edges) e.end(); await link.close(); });
  const edge = async () => { const e = await fakeEdge(link.port); edges.push(e); return e; };
  return { service, link, edge };
}

test('the first EDGE is answered with ACCEPT, a different link version closes the link, and a second edge is refused', async t => {
  const { link, edge } = await started(t, 4242);
  assert.equal(link.info(), null);
  const bad = await edge(); bad.hello({ link: LINK_VERSION - 1 });
  await waitFor(() => bad.closed, 'a version refusal');
  assert.equal(link.info(), null);

  const first = await edge(); first.hello();
  const accept = await first.next(FRAME.ACCEPT);
  assert.deepEqual(JSON.parse(accept.body.toString()), { link: LINK_VERSION, httpPort: 4242, maxMessageBytes: MAX_MESSAGE_BYTES });
  assert.deepEqual(link.info(), { port: 4433, certificateHash: 'ab'.repeat(32) });

  const second = await edge(); await waitFor(() => second.closed, 'a second edge refused');
  assert.equal(first.closed, false);

  first.hello({ port: 5544, certificateHash: null }); // a rotation: no second ACCEPT
  await waitFor(() => link.info()?.port === 5544, 'rotated info');
  assert.deepEqual(link.info(), { port: 5544, certificateHash: null });
  assert.equal(first.frames.some(f => f.type === FRAME.ACCEPT), false);
});

test('an edge session is a peer: text and binary deliveries, WRITTEN-driven backlog, droppable skips, and messages in', async t => {
  const { service, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  e.send(FRAME.OPEN, u32(7));
  await waitFor(() => service.peers.length === 1, 'a session');
  const { peer } = service.peers[0];
  assert.equal(peer.bytes, true);

  // Messages go through parseMessage to service.receive, split across TCP chunks.
  const message = Buffer.concat([u32(7), Buffer.from([0]), json({ type: 'ping', n: 1 })]);
  const framed = encodeFrame(FRAME.MESSAGE, message);
  e.socket.write(framed.subarray(0, 3)); await new Promise(r => setTimeout(r, 10)); e.socket.write(framed.subarray(3, 9)); e.socket.write(framed.subarray(9));
  await waitFor(() => service.received.length === 1, 'a message');
  assert.deepEqual(service.received[0], [0, { type: 'ping', n: 1 }]);

  assert.equal(peer.deliver('{"a":"é"}'), true);
  assert.equal(peer.deliver(new TextEncoder().encode('{"b":1}')), true);
  assert.equal(peer.deliver(Uint8Array.of(9, 8, 7), true, true), true);
  const frames = [await e.next(FRAME.DELIVER), await e.next(FRAME.DELIVER), await e.next(FRAME.DELIVER)];
  assert.deepEqual(frames.map(f => [f.body.readUInt32BE(0), f.body[4], f.body.subarray(5).toString('latin1')]),
    [[7, 0, Buffer.from('{"a":"é"}').toString('latin1')], [7, 0, '{"b":1}'], [7, 1, '\t\b\u0007']]);
  const sent = Buffer.byteLength('{"a":"é"}') + 7 + 3;
  assert.equal(peer.buffered(), sent);

  e.send(FRAME.WRITTEN, u32(7), u64(sent));
  await waitFor(() => peer.buffered() === 0, 'WRITTEN to drain');

  // A droppable frame is skipped over the backlog limit; one that is not droppable still goes.
  const big = new Uint8Array(MAX_BUFFERED_BYTES);
  assert.equal(peer.deliver(big, false, true), true);
  assert.equal(peer.buffered(), MAX_BUFFERED_BYTES);
  assert.equal(peer.deliver('{}', true), false, 'droppable skipped');
  assert.equal(peer.deliver('{}', false), true);
  e.send(FRAME.WRITTEN, u32(7), u64(sent + MAX_BUFFERED_BYTES + 2));
  await waitFor(() => peer.buffered() === 0, 'drain');
  assert.equal(peer.deliver('{}', true), true);
});

test('an edge session offers datagrams: each goes to the edge as one SEND, outside the backlog, and none once closing', async t => {
  const { service, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  e.send(FRAME.OPEN, u32(3));
  await waitFor(() => service.peers.length === 1, 'a session');
  const { peer } = service.peers[0];
  assert.equal(typeof peer.datagram, 'function', 'so the room gives it the split');
  assert.equal(peer.datagram(Uint8Array.of(1, 2, 3)), true);
  const sent = await e.next(FRAME.SEND);
  assert.deepEqual([sent.body.readUInt32BE(0), [...sent.body.subarray(4)]], [3, [1, 2, 3]]);
  assert.equal(peer.buffered(), 0, 'a datagram is not stream backlog');
  peer.close(1000, 'bye');
  assert.equal(peer.datagram(Uint8Array.of(4)), false);
});

test('close, invalid input and edge-side ends reach the session seam once', async t => {
  const { service, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  for (const id of [1, 2, 3, 4]) e.send(FRAME.OPEN, u32(id));
  await waitFor(() => service.peers.length === 4, 'four sessions');
  const closeOf = frame => [frame.body.readUInt32BE(0), frame.body.readUInt16BE(4), frame.body.subarray(6).toString()];

  service.peers[0].peer.close(CLOSE_CODE.NORMAL, 'Session resumed');
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [1, 1000, 'Session resumed']);
  assert.equal(service.peers[0].peer.deliver('{}'), false, 'nothing more is sent to a closing session');

  e.send(FRAME.MESSAGE, u32(2), Buffer.from([0]), Buffer.from('not json'));
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [2, 1008, CLOSE_REASON.INVALID_MESSAGE]);
  e.send(FRAME.MESSAGE, u32(3), Buffer.from([1]), Buffer.from([1, 2, 3]));
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [3, 1008, CLOSE_REASON.INVALID_MESSAGE]);
  assert.equal(service.received.length, 0);
  for (let i = 0; i < 80; i++) e.send(FRAME.MESSAGE, u32(4), Buffer.from([0]), json({ i }));
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [4, 1008, CLOSE_REASON.RATE_EXCEEDED]);

  e.send(FRAME.CLOSED, u32(2));
  await waitFor(() => service.disconnected.length === 1, 'a disconnect');
  e.send(FRAME.CLOSED, u32(2)); // already gone: nothing more
  e.end();
  await waitFor(() => service.disconnected.length === 4, 'the rest disconnected on link loss');
  assert.deepEqual(service.disconnected.toSorted(), [0, 1, 2, 3]);
});

test('input datagrams reach the room once each, in order, whichever path an input took', async t => {
  const { service, link, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  for (const id of [1, 2, 3, 4, 5]) e.send(FRAME.OPEN, u32(id));
  await waitFor(() => service.peers.length === 5, 'five sessions');
  const input = seq => ({ type: 'input', seq, tick: 100 + seq, x: 1 });
  const datagram = (id, ...seqs) => e.send(FRAME.DATAGRAM, u32(id), json({ inputs: seqs.map(input) }));
  const seqsOf = session => service.received.filter(([s]) => s === session).map(([, data]) => data.seq);
  const closeOf = frame => [frame.body.readUInt32BE(0), frame.body.readUInt16BE(4), frame.body.subarray(6).toString()];

  // Each datagram repeats the two inputs before its newest. The one carrying 2 is lost, and 2 arrives with 3;
  // a late, reordered copy passes nothing on.
  datagram(1, 0);
  datagram(1, 0, 1);
  datagram(1, 1, 2, 3);
  datagram(1, 0, 1, 2);
  // An input too large for a datagram takes the stream, and the datagrams' copies of it are not passed on again.
  e.send(FRAME.MESSAGE, u32(1), Buffer.from([0]), json(input(4)));
  datagram(1, 3, 4, 5);
  e.send(FRAME.MESSAGE, u32(1), Buffer.from([0]), json(input(5)));
  e.send(FRAME.MESSAGE, u32(1), Buffer.from([0]), json({ type: 'pong', token: 't' }));
  await waitFor(() => service.received.length === 7, 'the inputs and the pong');
  assert.deepEqual(seqsOf(0), [0, 1, 2, 3, 4, 5, undefined]);
  assert.deepEqual(service.received[0][1], input(0), 'an input reaches the room as it was sent');
  assert.deepEqual(link.counts(), { messages: 3, datagrams: 5, acks: 0, sends: 0 });

  // Anything but up to three inputs, oldest first, with non-negative seqs, is refused as invalid; the stage 2
  // array form among them.
  e.send(FRAME.DATAGRAM, u32(2), json({ inputs: [input(2), input(1)] }));
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [2, 1008, CLOSE_REASON.INVALID_MESSAGE]);
  e.send(FRAME.DATAGRAM, u32(4), json([input(1)]));
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [4, 1008, CLOSE_REASON.INVALID_MESSAGE]);
  assert.equal(seqsOf(1).length + seqsOf(3).length, 0);

  // The limit counts inputs, as on a WebSocket: a datagram of three new ones costs three, one of repeats costs one.
  for (let i = 0; i < 23; i++) datagram(5, 3 * i, 3 * i + 1, 3 * i + 2);
  // 69 counted so far. This datagram is the 70th, its first new input rides on it, and its second is one too many.
  datagram(5, 69, 70, 71);
  assert.deepEqual(closeOf(await e.next(FRAME.CLOSE)), [5, 1008, CLOSE_REASON.RATE_EXCEEDED]);
  assert.equal(seqsOf(4).length, MAX_MESSAGES_PER_SECOND);
});

test('acknowledgements ride the input datagrams and reach the service unless repeated', async t => {
  const { service, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  for (const id of [1, 2]) e.send(FRAME.OPEN, u32(id));
  await waitFor(() => service.peers.length === 2, 'two sessions');
  const send = (id, body) => e.send(FRAME.DATAGRAM, u32(id), json(body));
  send(1, { ack: 40, inputs: [{ type: 'input', seq: 1, tick: 41 }] });
  // An acknowledgement alone, with no input, is a datagram too. A repeat is dropped; a late, older one goes on, for
  // the room to judge, so a stray value cannot latch here.
  send(1, { ack: 42, inputs: [] });
  send(1, { ack: 42, inputs: [] });
  send(1, { ack: 41, inputs: [{ type: 'input', seq: 1, tick: 41 }] });
  send(1, { ack: 45, inputs: [{ type: 'input', seq: 2, tick: 46 }] });
  await waitFor(() => service.acks.length === 4 && service.received.length === 2, 'the acknowledgements');
  assert.deepEqual(service.acks, [[0, 40], [0, 42], [0, 41], [0, 45]]);
  // Neither an empty datagram nor a malformed acknowledgement is one.
  for (const [i, bad] of [{ inputs: [] }, { ack: -1, inputs: [] }, { ack: null, inputs: [{ type: 'input', seq: 1 }] }, { ack: 1.5, inputs: [] }, { ack: 3, inputs: [], extra: 1 }].entries()) {
    e.send(FRAME.OPEN, u32(10 + i));
    send(10 + i, bad);
    const close = await e.next(FRAME.CLOSE);
    assert.deepEqual([close.body.readUInt32BE(0), close.body.subarray(6).toString()], [10 + i, CLOSE_REASON.INVALID_MESSAGE], JSON.stringify(bad));
  }
  assert.equal(service.acks.length, 4);
});

test('an invalid input passes on to be refused, but does not hold back the valid ones after it', async t => {
  const { service, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  e.send(FRAME.OPEN, u32(1));
  await waitFor(() => service.peers.length === 1, 'a session');
  // No tick: the validator refuses it. A high seq on it must not latch.
  e.send(FRAME.DATAGRAM, u32(1), json({ inputs: [{ type: 'input', seq: 1000 }] }));
  e.send(FRAME.MESSAGE, u32(1), Buffer.from([0]), json({ type: 'input', seq: 2000, tick: -5 }));
  e.send(FRAME.DATAGRAM, u32(1), json({ inputs: [{ type: 'input', seq: 1, tick: 9 }] }));
  await waitFor(() => service.received.length === 3, 'three inputs');
  assert.deepEqual(service.received.map(([, data]) => data.seq), [1000, 2000, 1]);
});

test('a malformed frame drops the link and its sessions, and a new edge may then connect', async t => {
  const { service, link, edge } = await started(t);
  const e = await edge(); e.hello(); await e.next(FRAME.ACCEPT);
  e.send(FRAME.OPEN, u32(1));
  await waitFor(() => service.peers.length === 1, 'a session');
  e.socket.write(u32(64 * 1024 * 1024 + 1));
  await waitFor(() => e.closed, 'the link dropped');
  await waitFor(() => service.disconnected.length === 1 && link.info() === null, 'sessions gone');
  const again = await edge(); again.hello(); await again.next(FRAME.ACCEPT);

  const silent = await edge(); await waitFor(() => silent.closed, 'a second live edge refused');
  const raw = await fakeEdge(link.port); raw.send(FRAME.OPEN, u32(1)); // before EDGE
  await waitFor(() => raw.closed, 'OPEN before EDGE refused'); raw.end();
  again.socket.destroy(); await waitFor(() => link.info() === null, 'the linked edge gone');
  // An offer the browser could not be given is refused at the link, so client-config never carries it.
  const bad = await edge(); bad.hello({ certificateHash: 'not-hex' });
  await waitFor(() => bad.closed && link.info() === null, 'a malformed certificate hash refused');
});

test('client configuration offers WebTransport while an edge is linked, and through a real server a session gets a welcome path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'last-exit-edge-'));
  const server = await createArenaServer({ replayDir: dir, roomThreads: false, edgeLink: 0, generateMap: () => new Promise(() => {}) });
  try {
    const base = await listen(server);
    const config = async () => (await fetch(base + '/api/client-config')).json();
    assert.equal((await config()).webTransport, null);
    const e = await fakeEdge(server.edgeLink.port);
    e.hello({ port: 4444 });
    const accept = JSON.parse((await e.next(FRAME.ACCEPT)).body.toString());
    assert.equal(accept.httpPort, server.http.address().port);
    assert.deepEqual((await config()).webTransport, { port: 4444, certificateHash: 'ab'.repeat(32) });

    // An unknown room is refused through the directory as for a WebSocket: an error message, delivered as text.
    e.send(FRAME.OPEN, u32(1));
    e.send(FRAME.MESSAGE, u32(1), Buffer.from([0]), json({ type: 'join', room: 'nope', mode: 'player' }));
    const delivered = await e.next(FRAME.DELIVER);
    assert.equal(delivered.body[4], 0);
    assert.equal(JSON.parse(delivered.body.subarray(5).toString()).type, 'error');

    e.end();
    await waitFor(() => server.edgeLink.info() === null, 'link loss');
    assert.equal((await config()).webTransport, null);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
