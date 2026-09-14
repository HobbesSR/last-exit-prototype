import test from 'node:test';
import assert from 'node:assert/strict';
import { trackLatency, pingSession, acceptPong, roundTripMs, MAX_RTT_MS } from '../server/latency.js';

/** A session that records what was delivered to it, standing in for a socket. */
function session(id = 'c1') {
  const sent = [];
  return { session: trackLatency({ connectionId: id }), sent, deliver: (s, value) => sent.push(value) };
}
/** Ping, then echo the token that was actually sent, `after` milliseconds later. */
function roundTrip(h, at, after, { token } = {}) {
  pingSession(h.session, at, h.deliver);
  const sent = h.sent.at(-1);
  acceptPong(h.session, { token: token ?? sent.token }, at + after);
  return sent;
}

test('a round trip is timed by the server against its own clock', () => {
  const h = session();
  assert.equal(roundTripMs(h.session), null, 'nothing is claimed before the first echo returns');
  roundTrip(h, 1000, 42);
  assert.equal(roundTripMs(h.session), 42);
});

test('the client states no latency, it only returns a token', () => {
  const h = session();
  pingSession(h.session, 1000, h.deliver);
  const ping = h.sent.at(-1);
  assert.equal(ping.type, 'ping');
  assert.ok(ping.token, 'a token is sent');
  assert.equal(Object.hasOwn(ping, 'rtt'), true, 'the last measurement is echoed back for display');
  // A reply carrying a number rather than the token tells the server nothing.
  acceptPong(h.session, { token: ping.token, rtt: 1 }, 1005);
  assert.equal(roundTripMs(h.session), 5, 'the server used its own timing, not the reply');
});

test('a token the server did not just send is ignored', () => {
  const h = session();
  assert.equal(acceptPong(h.session, { token: 'invented' }, 1000), false, 'an invented token is refused');
  const ping = roundTrip(h, 1000, 20);
  // Replaying the same token cannot add a second, flattering sample.
  assert.equal(acceptPong(h.session, { token: ping.token }, 1001), false, 'a token is spent once');
  assert.equal(roundTripMs(h.session), 20);
});

test('a stalled echo cannot pull the reported figure up on its own', () => {
  const h = session();
  let at = 1000;
  // An honest connection, then a client that starts holding its echoes back to look slower than it
  // is — which is the direction that would buy it more rewind from anything trading on latency.
  for (const delay of [30, 28, 31]) { roundTrip(h, at, delay); at += 2000; }
  assert.equal(roundTripMs(h.session), 28);
  for (const delay of [300, 320]) { roundTrip(h, at, delay); at += 2000; }
  assert.equal(roundTripMs(h.session), 28, 'the minimum of the window survives two stalled echoes');
});

test('sustained stalling is bounded rather than believed', () => {
  const h = session();
  let at = 1000;
  for (let i = 0; i < 8; i++) { roundTrip(h, at, 5000); at += 2000; }
  assert.equal(roundTripMs(h.session), MAX_RTT_MS, 'a five-second echo is clamped, not taken at face value');
});

test('pings are rate limited to their own interval', () => {
  const h = session();
  assert.equal(pingSession(h.session, 1000, h.deliver), true, 'the first ping goes out');
  assert.equal(pingSession(h.session, 1200, h.deliver), false, 'a second inside the interval does not');
  assert.equal(pingSession(h.session, 2100, h.deliver), true, 'the next interval does');
  assert.equal(h.sent.length, 2);
});

test('an echo that arrives before the server sent anything is impossible to forge', () => {
  const h = session();
  pingSession(h.session, 1000, h.deliver);
  const first = h.sent.at(-1).token;
  // The token embeds the send time, so a client cannot produce the *next* one in advance.
  pingSession(h.session, 2100, h.deliver);
  const second = h.sent.at(-1).token;
  assert.notEqual(first, second);
  assert.equal(acceptPong(h.session, { token: first }, 2101), false, 'the superseded token no longer counts');
});

test('separate sessions keep separate measurements', () => {
  const a = session('a'), b = session('b');
  roundTrip(a, 1000, 15);
  roundTrip(b, 1000, 120);
  assert.equal(roundTripMs(a.session), 15);
  assert.equal(roundTripMs(b.session), 120);
});
