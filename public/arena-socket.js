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

import { INPUT_DATAGRAM_INPUTS, MAX_MESSAGE_BYTES } from '../shared/protocol.ts';

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
 * Packs encoded input messages, oldest first, as one datagram: a JSON array of as many of the newest as fit in
 * `max` bytes. Null when not even the newest fits.
 */
export function packInputDatagram(inputs, max = Infinity) {
  let from = inputs.length, size = 1;
  while (from > 0 && size + inputs[from - 1].length + 1 <= max) size += inputs[--from].length + 1;
  if (from === inputs.length) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (let i = from; i < inputs.length; i++) { out[at++] = i === from ? 0x5b : 0x2c; out.set(inputs[i], at); at += inputs[i].length; }
  out[at] = 0x5d;
  return out;
}

const hexBytes = hex => Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16));

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

    function useWebSocket() {
      const location = where();
      const ws = new (WS())(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
      underlying = ws; transport = 'websocket'; ws.binaryType = binaryType;
      ws.addEventListener('open', () => { if (readyState !== CONNECTING) return; readyState = OPEN; socket.dispatchEvent(event('open')); });
      ws.addEventListener('message', e => socket.dispatchEvent(event('message', { data: e.data })));
      ws.addEventListener('error', () => socket.dispatchEvent(event('error')));
      ws.addEventListener('close', e => settle(e.code, e.reason, e.wasClean));
      if (wantClose) ws.close(...wantClose);
      socket.send = data => ws.send(data);
      socket.sendInput = socket.send;
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
      socket.sendInput = text => {
        if (readyState !== OPEN) throw new DOMException('The socket is not open', 'InvalidStateError');
        if (!datagrams) return socket.send(text);
        const bytes = encoder.encode(text);
        // Read per send: the session's limit can change, and an oversized write vanishes silently (42.56). The
        // edge drops a datagram over the message limit, so that caps it too.
        const packed = packInputDatagram([...recent, bytes], Math.min(wt.datagrams.maxDatagramSize ?? Infinity, MAX_MESSAGE_BYTES));
        if (!packed) return socket.send(text);
        recent.push(bytes);
        if (recent.length >= INPUT_DATAGRAM_INPUTS) recent.shift();
        datagrams.write(packed).catch(() => {});
      };
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
    socket.close = (code, reason) => {
      if (readyState >= CLOSING) return;
      wantClose = [code, reason]; readyState = CLOSING;
      // Not yet connected: close at once, and abandon a WebTransport attempt still opening.
      if (transport === null) { cancelOpen?.(); queueMicrotask(() => { if (transport === null) settle(1006, '', false); }); }
    };

    (async () => {
      const forced = forcedTransport(where().search);
      // One budget covers the config, the session and its stream; a forced choice has none.
      const deadline = forced === 'wt' ? null : Date.now() + timeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      let offer = null;
      // A page that has fallen back stays on the WebSocket, so only a forced WebTransport still needs the offer.
      if (forced === 'wt' || (forced === null && !fellBack)) {
        let timer = null;
        const timeout = deadline === null ? null : new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining()); });
        const loaded = await (timeout ? Promise.race([config(), timeout]) : config());
        clearTimeout(timer);
        offer = loaded?.webTransport ?? null;
      }
      if (wantClose) { settle(1006, '', false); return; }
      const choice = chooseTransport({ forced, webTransport: offer, available: !!WT(), fellBack });
      if (choice === 'wt') {
        if (!offer || !WT()) { fail(); return; }
        if (await useWebTransport(offer, deadline === null ? null : remaining())) return;
        // The edge may have restarted or rotated its certificate: the next socket asks for the config again.
        configPromise = null;
        if (wantClose) { settle(1006, '', false); return; }
        if (forced === 'wt') { fail(); return; }
        fellBack = true;
      }
      if (wantClose) { settle(1006, '', false); return; }
      useWebSocket();
    })();
    return socket;
  };
}

/** The page's opener; its socket replaces `new WebSocket(...)` at every call site. */
export const openArenaSocket = createArenaSocketOpener();
