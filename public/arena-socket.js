// The browser's connection to the arena (24.5 "Stage 1's contracts"): a WebSocket-like socket that tries
// WebTransport through the edge when the server offers it and the browser has it, and otherwise, or on
// failure or timeout, uses the WebSocket for the rest of the page's life. Callers see one interface:
// `addEventListener('open' | 'message' | 'close' | 'error')`, `send(string)`, `sendInput(string)`,
// `close(code, reason)`, `readyState`, `bufferedAmount` and `binaryType`. A message's `data` is a string for a text
// frame and an ArrayBuffer for a binary one. `transport` names what the socket ended up on.
//
// `sendInput` is for `input` messages only (24.5 "Stage 2's contracts"). On WebTransport each goes as a datagram
// carrying it and the inputs sent just before it, so a lost datagram costs nothing while the next arrives; on a
// WebSocket it is `send`.
//
// On WebTransport the server may also send messages as datagrams (24.5 "Stage 3's contracts"): the edge splits
// each into up to four fragments, and the socket dispatches it as a binary `message` once all have arrived, as
// if it had come on the stream. `acknowledge(tick)` names the newest fast frame the page holds; it rides the next
// input datagram, or goes alone when no input has gone lately. On a WebSocket it does nothing.

import { INPUT_DATAGRAM_INPUTS, MAX_MESSAGE_BYTES } from '../shared/protocol.ts';
import { DATAGRAM_HEADER_BYTES, MAX_FAST_FRAGMENTS } from '../shared/fast-state.ts';

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
/** The client stream's flag byte; `tests/edge-contract.test.js` holds it to the edge's. */
export const FLAG = Object.freeze({ TEXT: 0, BINARY: 1 });
const { TEXT: FLAG_TEXT, BINARY: FLAG_BINARY } = FLAG;
/** How long WebTransport has to open its session and stream before the WebSocket is used. */
export const FALLBACK_MS = 3000;
const encoder = new TextEncoder(), decoder = new TextDecoder();

/** `?transport=ws` or `?transport=wt` force one transport; anything else leaves the choice to the page. */
export function forcedTransport(search) {
  const value = new URLSearchParams(search).get('transport');
  return value === 'ws' || value === 'wt' ? value : null;
}

/**
 * Which transport to try first, as `'wt'` or `'ws'`: WebTransport when the config offers it, the browser has
 * it and the page has not already fallen back, or when forced to it (a forced choice never falls back).
 */
export function chooseTransport({ forced, webTransport, available, fellBack }) {
  if (forced === 'ws') return 'ws';
  if (forced === 'wt') return 'wt';
  return webTransport && available && !fellBack ? 'wt' : 'ws';
}

/**
 * Packs encoded input messages, oldest first, as one datagram (24.5 "Stage 2's contracts"): a JSON object
 * `{ ack?, inputs }` whose `inputs` are as many of the newest as fit in `max` bytes. `ack` is the newest fast
 * frame's tick the client holds, or null for none. With no inputs and an `ack`, the datagram carries the
 * acknowledgement alone. Null when not even the newest input fits.
 */
export function packInputDatagram(inputs, max = Infinity, ack = null) {
  const head = encoder.encode(ack === null ? '{"inputs":[' : `{"ack":${ack},"inputs":[`);
  if (!inputs.length) return ack === null || head.length + 2 > max ? null : encoder.encode(`{"ack":${ack},"inputs":[]}`);
  // The head, then each input and its separator (a comma, or the closing `]`), then the closing brace.
  let from = inputs.length, size = head.length + 1;
  while (from > 0 && size + inputs[from - 1].length + 1 <= max) size += inputs[--from].length + 1;
  if (from === inputs.length) return null;
  const out = new Uint8Array(size);
  out.set(head);
  let at = head.length;
  for (let i = from; i < inputs.length; i++) { if (i > from) out[at++] = 0x2c; out.set(inputs[i], at); at += inputs[i].length; }
  out[at++] = 0x5d; out[at] = 0x7d;
  return out;
}

const hexBytes = hex => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16));

/**
 * Rebuilds the server's datagram messages from the edge's fragments (24.5 "Delivery"): each datagram is a `u16`
 * big-endian message number, a `u8` index and a `u8` count, then its part of the message. Push each datagram; a
 * message comes back once every fragment of it has arrived, otherwise null. A fragment that is malformed or
 * repeated is ignored. At most `pending` incomplete messages are kept, and none more than `pending` numbers from
 * the newest datagram's, so a message that lost a fragment is forgotten as later ones arrive.
 */
export function createDatagramAssembler(pending = 8) {
  const partial = new Map();
  return datagram => {
    if (datagram.length <= DATAGRAM_HEADER_BYTES) return null;
    const number = (datagram[0] << 8) | datagram[1], index = datagram[2], count = datagram[3];
    if (count < 1 || count > MAX_FAST_FRAGMENTS || index >= count) return null;
    // Numbers wrap at 2^16: an incomplete message more than `pending` numbers behind this one is forgotten,
    // whatever arrives, so it cannot linger until its number comes round again.
    for (const held of partial.keys()) if (((number - held) & 0xffff) > pending && ((held - number) & 0xffff) > pending) partial.delete(held);
    const part = datagram.subarray(DATAGRAM_HEADER_BYTES);
    if (count === 1) return part;
    let held = partial.get(number);
    // The number wraps; a different count means an old message's leftovers under a reused number.
    if (held?.count !== count) {
      partial.delete(number);
      partial.set(number, held = { count, parts: new Array(count), arrived: 0 });
      for (const oldest of partial.keys()) { if (partial.size <= pending) break; partial.delete(oldest); }
    }
    if (held.parts[index]) return null;
    held.parts[index] = part;
    if (++held.arrived < count) return null;
    partial.delete(number);
    const out = new Uint8Array(held.parts.reduce((size, p) => size + p.length, 0));
    let at = 0;
    for (const p of held.parts) { out.set(p, at); at += p.length; }
    return out;
  };
}

/** How long without an input datagram before an acknowledgement is sent alone. */
export const ACK_ALONE_MS = 100;

/** One frame: u32 big-endian length of what follows, a u8 flag (0 text, 1 binary), then the payload. */
export function encodeStreamFrame(data) {
  const binary = typeof data !== 'string';
  const payload = binary ? (ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)) : encoder.encode(data);
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, 1 + payload.length);
  out[4] = binary ? FLAG_BINARY : FLAG_TEXT; out.set(payload, 5);
  return out;
}

/** Splits a byte stream into frames: push chunks, and each complete frame comes back as `{ binary, payload }`. */
export function createFrameReader() {
  let pending = new Uint8Array(0);
  return chunk => {
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending); joined.set(chunk, pending.length);
    const frames = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0);
      if (length < 1) throw new Error('Malformed stream frame');
      if (joined.length - at < 4 + length) break;
      frames.push({ binary: joined[at + 4] === FLAG_BINARY, payload: joined.subarray(at + 5, at + 4 + length) });
      at += 4 + length;
    }
    pending = joined.subarray(at);
    return frames;
  };
}

function event(type, fields) {
  const made = new Event(type);
  return fields ? Object.assign(made, fields) : made;
}

/**
 * Builds the opener a page uses. `env` replaces what it reads, for tests: `location` (`hostname`, `host`,
 * `protocol`, `search`), `fetchConfig()`, `WebSocket`, `WebTransport` (read at each open) and `timeoutMs`.
 * The page-wide state, the config and whether WebTransport has failed, lives in the opener.
 */
export function createArenaSocketOpener(env = {}) {
  const where = () => env.location ?? globalThis.location;
  const WS = () => env.WebSocket ?? globalThis.WebSocket;
  const WT = () => ('WebTransport' in env ? env.WebTransport : globalThis.WebTransport);
  const timeoutMs = env.timeoutMs ?? FALLBACK_MS;
  const fetchConfig = env.fetchConfig ?? (() => fetch('/api/client-config', { cache: 'no-store' }).then(r => r.ok ? r.json() : null));
  let configPromise = null, fellBack = false;

  // Once per page; a failed or unreadable answer is forgotten, so a later socket asks again.
  function config() {
    configPromise ??= Promise.resolve().then(fetchConfig).catch(() => null).then(value => {
      if (value === null || typeof value !== 'object') configPromise = null;
      return value ?? null;
    });
    return configPromise;
  }

  return function openArenaSocket() {
    const socket = new EventTarget();
    let readyState = CONNECTING, binaryType = 'blob', transport = null;
    let underlying = null, dispatchedClose = false, wantClose = null, buffered = 0;
    const settle = (code, reason, wasClean) => {
      if (dispatchedClose) return;
      dispatchedClose = true; readyState = CLOSED;
      socket.dispatchEvent(event('close', { code, reason, wasClean }));
    };
    const fail = () => { if (dispatchedClose) return; socket.dispatchEvent(event('error')); settle(1006, '', false); };
    // Abandons a WebTransport attempt still opening, when the caller closes the socket first.
    let cancelOpen = null;

    Object.defineProperties(socket, {
      readyState: { get: () => readyState },
      bufferedAmount: { get: () => buffered + (transport === 'websocket' ? underlying?.bufferedAmount ?? 0 : 0) },
      binaryType: { get: () => binaryType, set: value => { binaryType = value; if (transport === 'websocket' && underlying) underlying.binaryType = value; } },
      transport: { get: () => transport },
      url: { value: '' },
    });
    socket.CONNECTING = CONNECTING; socket.OPEN = OPEN; socket.CLOSING = CLOSING; socket.CLOSED = CLOSED;

    function useWebSocket(wsOffer) {
      const location = where();
      const protocol = wsOffer.tls ? 'wss' : 'ws';
      const ws = new (WS())(`${protocol}://${location.hostname}:${wsOffer.port}/arena`);
      underlying = ws; transport = 'websocket'; ws.binaryType = binaryType;
      ws.addEventListener('open', () => { if (readyState !== CONNECTING) return; readyState = OPEN; socket.dispatchEvent(event('open')); });
      ws.addEventListener('message', e => socket.dispatchEvent(event('message', { data: e.data })));
      ws.addEventListener('error', () => { if (readyState === CONNECTING) configPromise = null; socket.dispatchEvent(event('error')); });
      ws.addEventListener('close', e => { if (readyState === CONNECTING) configPromise = null; settle(e.code, e.reason, e.wasClean); });
      if (wantClose) ws.close(...wantClose);
      socket.send = data => ws.send(data);
      socket.sendInput = socket.send;
      socket.acknowledge = () => {};
      socket.close = (code, reason) => { if (readyState >= CLOSING) return; readyState = CLOSING; ws.close(code, reason); };
    }

    /**
     * Opens the session and its stream within `limit` ms (none when null); resolves with false if it could not, or
     * if the socket was closed meanwhile, in which case the session is closed at once.
     */
    async function useWebTransport(offer, limit) {
      const location = where(), Transport = WT();
      let wt = null, timer = null;
      const aborted = new Promise((_, reject) => { cancelOpen = () => reject(new Error('Closed while connecting')); });
      const options = offer.certificateHash ? { serverCertificateHashes: [{ algorithm: 'sha-256', value: hexBytes(offer.certificateHash) }] } : {};
      try {
        wt = new Transport(`https://${location.hostname}:${offer.port}/arena`, options);
        const opened = (async () => { await wt.ready; return wt.createBidirectionalStream(); })();
        opened.catch(() => {});
        const timeout = limit === null ? null : new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('WebTransport timed out')); }, limit); });
        aborted.catch(() => {});
        const stream = await Promise.race(timeout ? [opened, timeout, aborted] : [opened, aborted]);
        clearTimeout(timer); cancelOpen = null;
        if (wantClose) throw new Error('Closed while connecting');
        attach(wt, stream);
        return true;
      } catch {
        clearTimeout(timer); cancelOpen = null;
        try { wt?.close(); } catch { /* Already failed. */ }
        return false;
      }
    }

    function attach(wt, stream) {
      underlying = wt; transport = 'webtransport';
      const writer = stream.writable.getWriter(), reader = stream.readable.getReader();
      const frames = createFrameReader();
      let reading = true;
      readyState = OPEN;
      socket.send = data => {
        if (readyState !== OPEN) throw new DOMException('The socket is not open', 'InvalidStateError');
        const frame = encodeStreamFrame(data);
        buffered += frame.length;
        writer.write(frame).then(() => { buffered -= frame.length; }, () => { buffered = 0; });
      };
      // The session's datagrams, when it has them; without, inputs share the stream.
      let datagrams = null;
      try { datagrams = (wt.datagrams?.createWritable ? wt.datagrams.createWritable() : wt.datagrams?.writable)?.getWriter() ?? null; } catch { datagrams = null; }
      const recent = [];
      // The newest fast frame's tick to acknowledge, and when a datagram last carried one.
      let ack = null, sentAt = -Infinity;
      // Read per send: the session's limit can change, and an oversized write vanishes silently (42.56). The
      // edge drops a datagram over the message limit, so that caps it too.
      const datagramLimit = () => Math.min(wt.datagrams.maxDatagramSize ?? Infinity, MAX_MESSAGE_BYTES);
      socket.sendInput = text => {
        if (readyState !== OPEN) throw new DOMException('The socket is not open', 'InvalidStateError');
        if (!datagrams) return socket.send(text);
        const bytes = encoder.encode(text);
        const packed = packInputDatagram([...recent, bytes], datagramLimit(), ack);
        if (!packed) return socket.send(text);
        recent.push(bytes);
        if (recent.length >= INPUT_DATAGRAM_INPUTS) recent.shift();
        sentAt = performance.now();
        datagrams.write(packed).catch(() => {});
      };
      socket.acknowledge = tick => {
        if (readyState !== OPEN || !datagrams || tick === ack) return;
        ack = tick;
        // An active page's next input carries it; an idle one (dead, or waiting for the match) sends it alone.
        const now = performance.now();
        if (now - sentAt < ACK_ALONE_MS) return;
        const packed = packInputDatagram([], datagramLimit(), ack);
        if (!packed) return;
        sentAt = now;
        datagrams.write(packed).catch(() => {});
      };
      // The server's datagrams, rebuilt from the edge's fragments and dispatched as stream messages are.
      const readable = wt.datagrams?.readable;
      if (readable) {
        const assemble = createDatagramAssembler();
        (async () => {
          const datagramReader = readable.getReader();
          try {
            while (true) {
              const { value, done } = await datagramReader.read();
              if (done) break;
              const message = assemble(value);
              if (message && readyState === OPEN) socket.dispatchEvent(event('message', { data: binaryType === 'blob' ? new Blob([message]) : message.slice().buffer }));
            }
          } catch { /* The session ended; its close is reported by `closed`. */ }
        })();
      }
      socket.close = (code, reason) => {
        if (readyState >= CLOSING) return;
        readyState = CLOSING;
        try { wt.close({ closeCode: code ?? 1000, reason: reason ?? '' }); } catch { /* Already closed. */ }
      };
      // The session's close info is the socket's: the WebSocket's code and reason ride as the application error code.
      wt.closed.then(info => settle(info?.closeCode ?? 1005, info?.reason ?? '', true), () => { socket.dispatchEvent(event('error')); settle(1006, '', false); });
      socket.dispatchEvent(event('open'));
      (async () => {
        try {
          while (reading) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const frame of frames(value)) {
              // As a WebSocket does: a binary message is a Blob unless the caller asked for an ArrayBuffer.
              const data = !frame.binary ? decoder.decode(frame.payload)
                : binaryType === 'blob' ? new Blob([frame.payload]) : frame.payload.slice().buffer;
              if (readyState === OPEN) socket.dispatchEvent(event('message', { data }));
            }
          }
        } catch {
          if (readyState === OPEN) { try { wt.close({ closeCode: 1002, reason: 'Unreadable stream' }); } catch { /* Gone. */ } }
        }
      })();
    }

    socket.send = () => { throw new DOMException('The socket is not open', 'InvalidStateError'); };
    socket.sendInput = socket.send;
    socket.acknowledge = () => {};
    socket.close = (code, reason) => {
      if (readyState >= CLOSING) return;
      wantClose = [code, reason]; readyState = CLOSING;
      // Not yet connected: close at once, and abandon a WebTransport attempt still opening.
      if (transport === null) { cancelOpen?.(); queueMicrotask(() => { if (transport === null) settle(1006, '', false); }); }
    };

    (async () => {
      const forced = forcedTransport(where().search);
      // One budget covers the config, the session and its stream when WebTransport can fall back; a forced
      // choice or a page already on WebSocket waits on the config without cutting it off.
      const deadline = forced === null && !fellBack ? Date.now() + timeoutMs : null;
      const remaining = () => Math.max(0, deadline - Date.now());
      let timer = null;
      const timeout = deadline === null ? null : new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining()); });
      const loaded = await (timeout ? Promise.race([config(), timeout]) : config());
      clearTimeout(timer);
      if (wantClose) { settle(1006, '', false); return; }
      const offer = loaded?.webTransport ?? null;
      const wsOffer = loaded?.webSocket ?? null;
      const choice = chooseTransport({ forced, webTransport: offer, available: !!WT(), fellBack });
      if (choice === 'wt') {
        if (!offer || !WT()) { configPromise = null; fail(); return; }
        if (await useWebTransport(offer, deadline === null ? null : remaining())) return;
        // The edge may have restarted or rotated its certificate: forget the cached offer when staying on
        // WebTransport or aborted, while a page falling back keeps its WebSocket offer without re-fetching.
        if (wantClose) { configPromise = null; settle(1006, '', false); return; }
        if (forced === 'wt') { configPromise = null; fail(); return; }
        fellBack = true;
      }
      if (wantClose) { settle(1006, '', false); return; }
      if (!wsOffer) { configPromise = null; fail(); return; }
      useWebSocket(wsOffer);
    })();
    return socket;
  };
}

/** The page's opener; its socket replaces `new WebSocket(...)` at every call site. */
export const openArenaSocket = createArenaSocketOpener();
