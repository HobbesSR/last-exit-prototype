import * as profiler from '../shared/profiler.ts';

// Round-trip time per session, measured by the server against its own clock.
//
// The server stamps a token, the client echoes it, and the server times the return. Nothing about
// this is asserted by the client: it cannot report a number, only return a token it could not have
// held before the server sent it, which is what stops an echo arriving before the round trip
// genuinely completed.
//
// It can still stall an echo, and that only ever makes its own latency look worse. That direction is
// the dangerous one for anything that trades on latency — rewinding the world to where a shooter saw
// it buys a slower-looking client more rewind — so the reported figure is the *minimum* of recent
// samples rather than their mean, and it is clamped. A lag switch cannot pull a minimum upward
// without holding back every echo in the window, and the clamp bounds what it would win if it did.
//
// Consumers must treat the result as an upper bound the server chose, never as a client statement.

const PING_INTERVAL_MS = 1000;
/** Samples kept per session. The minimum is taken across these, so this is the window a stall must cover. */
const SAMPLES = 5;
/** Beyond this a connection is too slow to compensate for, and pretending otherwise only helps a cheat. */
export const MAX_RTT_MS = 400;

/** Per-session latency state. Sessions are plain objects, so this initialises in place. */
export function trackLatency(session) {
  session.rttSamples = [];
  session.pingToken = null;
  session.pingSentAt = 0;
  session.lastPingAt = 0;
  return session;
}

/** Stamp and send a token if this session is due one. */
export function pingSession(session, now, deliver) {
  if (session.lastPingAt && now - session.lastPingAt < PING_INTERVAL_MS) return false;
  session.lastPingAt = now;
  // One outstanding token at a time: a reply carrying anything else is stale or invented.
  session.pingToken = `${session.connectionId}:${now}`;
  session.pingSentAt = now;
  deliver(session, { type: 'ping', token: session.pingToken, rtt: roundTripMs(session) });
  return true;
}

/** Time an echoed token. Anything that is not the outstanding token is ignored rather than trusted. */
export function acceptPong(session, data, now) {
  if (!session.pingToken || data?.token !== session.pingToken) return false;
  const sample = Math.max(0, Math.min(MAX_RTT_MS, now - session.pingSentAt));
  session.pingToken = null;
  session.rttSamples.push(sample);
  while (session.rttSamples.length > SAMPLES) session.rttSamples.shift();
  profiler.observe('net.rttMs', sample);
  return true;
}

/**
 * The session's round trip in milliseconds, or null before the first echo returns.
 *
 * The minimum of the window, not the mean: every source of error here is one-sided. A delayed echo,
 * a busy client tab and a scheduler hiccup all inflate a sample and none of them deflate one, so the
 * smallest recent sample is the closest thing to the true path time.
 */
export function roundTripMs(session) {
  return session.rttSamples?.length ? Math.min(...session.rttSamples) : null;
}
