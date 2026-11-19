import { createServer } from 'node:net';
import { CLIENT_MESSAGE, CLOSE_CODE, CLOSE_REASON, MAX_MESSAGE_BYTES, deliverable, isWebTransportOffer, parseMessage, parseInputDatagram, acceptMessageRate, validateClientMessage } from './protocol.js';

// The link between the WebTransport edge and this process (24.5 "The link"): one loopback TCP connection the
// edge opens, carrying every edge session as a peer behind the same session seam a WebSocket uses, so a room
// cannot tell the transport. Inputs may also arrive as datagrams (24.5 "Stage 2's contracts"), each carrying the
// newest input and those just before it; the link passes each input on once, in order, so the room sees what a
// WebSocket would have given it.

export const LINK_VERSION = 2;
/** The longest frame (type and body) the link accepts; a longer length is a malformed link. */
export const MAX_LINK_FRAME_BYTES = 64 * 1024 * 1024;

export const FRAME = Object.freeze({
  EDGE: 0x01, ACCEPT: 0x81, OPEN: 0x02, MESSAGE: 0x03, DELIVER: 0x82, WRITTEN: 0x04, CLOSE: 0x83, CLOSED: 0x05,
  DATAGRAM: 0x06,
});

/** A message frame's flag byte, as the client stream and MESSAGE/DELIVER carry it. */
export const FLAG = Object.freeze({ TEXT: 0, BINARY: 1 });
const { TEXT: FLAG_TEXT, BINARY: FLAG_BINARY } = FLAG;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });

/** One frame: u32 big-endian length of what follows, a u8 type, then the body parts. */
export function encodeFrame(type, ...parts) {
  let body = 0;
  for (const part of parts) body += part.length;
  const out = Buffer.allocUnsafe(5 + body);
  out.writeUInt32BE(1 + body, 0); out[4] = type;
  let at = 5;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const u32 = value => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(value); return b; };
const closeHeader = (id, code) => { const b = Buffer.allocUnsafe(6); b.writeUInt32BE(id, 0); b.writeUInt16BE(code, 4); return b; };

function readEdge(body) {
  try {
    const edge = JSON.parse(decoder.decode(body));
    // What the browser will be offered must pass the same check /api/client-config applies.
    if (!edge || typeof edge !== 'object' || !isWebTransportOffer({ port: edge.port, certificateHash: edge.certificateHash })) return null;
    return edge;
  } catch { return null; }
}

/**
 * Listens on `host:port` (0 picks a free port) and accepts one edge at a time. `service` is the host's
 * `{ connect, receive, disconnect }`. `httpPort` is a number or a function, read when ACCEPT is sent, since
 * the HTTP server may not be listening yet. Returns `{ listening, port, info, counts, close }`: `listening`
 * resolves once bound, `port` is the bound link port, `info()` is the latest `{ port, certificateHash }` of the
 * linked edge, or null while none is linked, and `counts()` is how many MESSAGE and DATAGRAM frames have arrived
 * since the listener started.
 */
export function attachEdgeLink({ service, port = 0, host = '127.0.0.1', httpPort }) {
  const server = createServer();
  let live = null, info = null;
  const counts = { messages: 0, datagrams: 0 };
  const sockets = new Set();

  server.on('connection', socket => {
    if (live) { socket.destroy(); return; }
    socket.setNoDelay(true);
    const link = live = { sessions: new Map(), accepted: false };
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    const send = frame => { if (!socket.destroyed) socket.write(frame); };
    const drop = () => socket.destroy();

    function openSession(id) {
      // `inputSeq` is the newest input `seq` passed on from either path.
      const state = { sent: 0, written: 0, closing: false, ended: false, rate: { start: Date.now(), messages: 0 }, inputSeq: -Infinity, session: null };
      link.sessions.set(id, state);
      const buffered = () => Math.max(0, state.sent - state.written);
      state.session = service.connect({
        // Says whether the payload went, as a WebSocket's does (server/websocket.js).
        deliver: (payload, droppable = false, binary = false) => {
          if (state.ended || state.closing || socket.destroyed || !deliverable(buffered(), droppable)) return false;
          const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
          send(encodeFrame(FRAME.DELIVER, u32(id), Uint8Array.of(binary ? FLAG_BINARY : FLAG_TEXT), bytes));
          state.sent += bytes.length;
          return true;
        },
        bytes: true,
        buffered,
        close: (code, reason) => {
          if (state.ended || state.closing) return;
          state.closing = true;
          send(encodeFrame(FRAME.CLOSE, closeHeader(id, code), encoder.encode(reason ?? '')));
        },
      });
    }
    // Refuses a session's traffic: the client is closed with 1008 and nothing more of it is read.
    function reject(id, state, reason) {
      state.closing = true;
      send(encodeFrame(FRAME.CLOSE, closeHeader(id, CLOSE_CODE.POLICY_VIOLATION), encoder.encode(reason)));
    }
    // An input reaches the room only when it is newer than every valid input before it, whichever path each
    // took. An invalid one goes on unlatched, for the service to refuse as it would any message, so it cannot
    // hold back the valid inputs after it. Says whether a new input was passed on.
    function passInput(state, input) {
      if (input.seq <= state.inputSeq) return false;
      if (validateClientMessage(input).ok) state.inputSeq = input.seq;
      service.receive(state.session, input);
      return true;
    }
    const endSession = id => {
      const state = link.sessions.get(id);
      if (!state || state.ended) return;
      state.ended = true; link.sessions.delete(id);
      service.disconnect(state.session);
    };

    function handle(type, body) {
      if (!link.accepted) {
        if (type !== FRAME.EDGE) return drop();
        const edge = readEdge(body);
        if (!edge || edge.link !== LINK_VERSION) return drop();
        link.accepted = true; info = { port: edge.port, certificateHash: edge.certificateHash };
        const http = typeof httpPort === 'function' ? httpPort() : httpPort;
        send(encodeFrame(FRAME.ACCEPT, encoder.encode(JSON.stringify({ link: LINK_VERSION, httpPort: http, maxMessageBytes: MAX_MESSAGE_BYTES }))));
        return;
      }
      switch (type) {
        case FRAME.EDGE: {
          const edge = readEdge(body);
          if (!edge || edge.link !== LINK_VERSION) return drop();
          info = { port: edge.port, certificateHash: edge.certificateHash };
          return;
        }
        case FRAME.OPEN: {
          if (body.length !== 4) return drop();
          const id = body.readUInt32BE(0);
          if (link.sessions.has(id)) return drop();
          return openSession(id);
        }
        case FRAME.MESSAGE: {
          if (body.length < 5) return drop();
          const id = body.readUInt32BE(0), state = link.sessions.get(id);
          counts.messages++;
          if (!state || state.closing) return;
          if (!acceptMessageRate(state.rate, Date.now())) return reject(id, state, CLOSE_REASON.RATE_EXCEEDED);
          if (body[4] !== FLAG_TEXT) return reject(id, state, CLOSE_REASON.INVALID_MESSAGE);
          let data;
          try { data = parseMessage(body.subarray(5)); } catch { return reject(id, state, CLOSE_REASON.INVALID_MESSAGE); }
          // An input too large for a datagram comes this way; one without a usable seq is the validator's to refuse.
          if (data?.type === CLIENT_MESSAGE.INPUT && Number.isSafeInteger(data.seq)) return passInput(state, data);
          service.receive(state.session, data);
          return;
        }
        case FRAME.DATAGRAM: {
          if (body.length < 5) return drop();
          const id = body.readUInt32BE(0), state = link.sessions.get(id);
          counts.datagrams++;
          if (!state || state.closing) return;
          // A datagram is one message to the rate limit, and each new input past its first is one more: the limit
          // counts inputs as on a WebSocket, and a datagram of repeats still costs one.
          const now = Date.now();
          if (!acceptMessageRate(state.rate, now)) return reject(id, state, CLOSE_REASON.RATE_EXCEEDED);
          let inputs;
          try { inputs = parseInputDatagram(body.subarray(4)); } catch { inputs = null; }
          if (!inputs) return reject(id, state, CLOSE_REASON.INVALID_MESSAGE);
          let passed = 0;
          for (const input of inputs) {
            if (state.closing) return;
            if (input.seq <= state.inputSeq) continue;
            if (passed++ && !acceptMessageRate(state.rate, now)) return reject(id, state, CLOSE_REASON.RATE_EXCEEDED);
            passInput(state, input);
          }
          return;
        }
        case FRAME.WRITTEN: {
          if (body.length !== 12) return drop();
          const state = link.sessions.get(body.readUInt32BE(0));
          if (state) state.written = Number(body.readBigUInt64BE(4));
          return;
        }
        case FRAME.CLOSED: {
          if (body.length !== 4) return drop();
          return endSession(body.readUInt32BE(0));
        }
        default: return drop();
      }
    }

    socket.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (!socket.destroyed && pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (length < 1 || length > MAX_LINK_FRAME_BYTES) return drop();
        if (pending.length < 4 + length) return;
        const type = pending[4], body = pending.subarray(5, 4 + length);
        pending = pending.subarray(4 + length);
        handle(type, body);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (live !== link) return;
      live = null; info = null;
      for (const id of [...link.sessions.keys()]) endSession(id);
    });
  });

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return {
    listening,
    get port() { return server.address()?.port ?? null; },
    info: () => info,
    counts: () => ({ ...counts }),
    close: () => new Promise(resolve => {
      if (!server.listening) { for (const s of sockets) s.destroy(); return resolve(); }
      server.close(() => resolve());
      for (const s of sockets) s.destroy();
    }),
  };
}
