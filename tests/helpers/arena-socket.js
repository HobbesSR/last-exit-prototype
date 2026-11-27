import net from 'node:net';
import { createFrameNormalizer } from '../../shared/relational-frame.ts';
import { WebSocket, WebSocketServer } from 'ws';
import { createLayerDecoder } from '../../shared/frame-layers.ts';
import { readServerMessage } from '../../shared/wire-schema.ts';
import { CAPABILITY, encodeFrame, FLAG, FRAME, LINK_VERSION } from '../../server/edge-link.js';
import { MAX_MESSAGE_BYTES } from '../../server/protocol.js';

/**
 * What the end-to-end server suites share for talking to a live arena over its socket and HTTP API.
 * Each suite still arranges and asserts its own scenario; only the waiting and room setup live here.
 */

// A socket's layer decoder; a state frame read here is decoded as the client would (#250). Frames that
// arrive while nothing waits are not decoded, so read layers only from a session's first frame or keyframes.
const decoders = new WeakMap(), hydrated = new WeakMap();
/** A server message as a `ws` socket hands it over: text, or a binary `state` message (24.1). */
export const readSocketMessage = (raw, binary) => readServerMessage(binary ? new Uint8Array(raw) : raw.toString());

/**
 * Bridges a loopback `ws` WebSocketServer to `server.edgeLink` speaking `LINK_VERSION` for fast unit
 * tests without compiling `last-exit-edge`. Wraps `server.close()` so teardown stops the bridge first.
 */
export async function attachTestEdge(server) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: MAX_MESSAGE_BYTES });
  await new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => { wss.off('error', reject); resolve(); });
  });
  const wsPort = wss.address().port;
  const link = net.connect(server.edgeLink.port, '127.0.0.1');
  link.setNoDelay(true);
  await new Promise((resolve, reject) => {
    link.once('error', reject);
    link.once('connect', () => { link.off('error', reject); resolve(); });
  });
  const sessions = new Map();
  let nextId = 1;
  let accepted = false;
  let buf = Buffer.alloc(0);
  const sendLink = (type, ...parts) => { if (!link.destroyed) link.write(encodeFrame(type, ...parts)); };
  const u32 = n => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n, 0); return b; };
  const u64 = n => { const b = Buffer.allocUnsafe(8); b.writeBigUInt64BE(BigInt(n), 0); return b; };

  const acceptReady = new Promise((resolve, reject) => {
    link.on('error', reject);
    link.on('data', chunk => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        const type = buf[4], body = buf.subarray(5, 4 + len);
        buf = buf.subarray(4 + len);
        if (type === FRAME.ACCEPT) { accepted = true; resolve(); }
        else if (type === FRAME.DELIVER && body.length >= 5) {
          const id = body.readUInt32BE(0), binary = body[4] === FLAG.BINARY, payload = body.subarray(5);
          const entry = sessions.get(id);
          if (entry && entry.ws.readyState === WebSocket.OPEN) {
            entry.ws.send(binary ? payload : payload.toString('utf8'), { binary });
            entry.written += payload.length;
            sendLink(FRAME.WRITTEN, u32(id), u64(entry.written));
          }
        } else if (type === FRAME.CLOSE && body.length >= 6) {
          const id = body.readUInt32BE(0), code = body.readUInt16BE(4), reason = body.subarray(6).toString('utf8');
          sessions.get(id)?.ws.close(code, reason);
        }
      }
    });
  });

  sendLink(FRAME.EDGE, Buffer.from(JSON.stringify({
    link: LINK_VERSION, port: 4433, wsPort, wsTls: false, certificateHash: null, validUntil: 0,
  })));
  await acceptReady;

  wss.on('connection', (ws, req) => {
    if (!accepted || new URL(req.url || '/', 'http://127.0.0.1').pathname !== '/arena') {
      ws.close(1008);
      return;
    }
    const id = nextId++;
    sessions.set(id, { ws, written: 0 });
    sendLink(FRAME.OPEN, u32(id), Uint8Array.of(CAPABILITY.STREAM_ONLY));
    ws.on('message', (raw, binary) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      sendLink(FRAME.MESSAGE, u32(id), Uint8Array.of(binary ? FLAG.BINARY : FLAG.TEXT), bytes);
    });
    ws.on('close', () => {
      if (sessions.delete(id)) sendLink(FRAME.CLOSED, u32(id));
    });
    ws.on('error', () => {});
  });

  const stop = async () => {
    for (const ws of wss.clients) ws.terminate();
    link.destroy();
    await new Promise(resolve => wss.close(resolve));
  };
  const origClose = server.close.bind(server);
  server.close = async () => {
    await stop();
    return origClose();
  };
  return { wsPort, stop };
}

/**
 * The next message of `type` that `accept` takes. It stops listening once it settles, whether it is
 * answered or times out, so a failed wait leaves nothing behind on the socket.
 */
export function next(ws, type, timeoutMs = 5000, accept = () => true) {
  if (!decoders.has(ws)) decoders.set(ws, createLayerDecoder());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    function receive(raw, binary) {
      const data = hydrated.get(ws)?.raw === raw ? hydrated.get(ws).data : readSocketMessage(raw, binary);
      if (data.type === type && accept(data)) { clearTimeout(timer); ws.off('message', receive); resolve(data); }
    }
    ws.on('message', receive);
  });
}
/** A socket to the arena at `base` (its http URL), routed through the linked edge's WebSocket port. */
export async function open(base) {
  const config = await (await fetch(`${base}/api/client-config`)).json();
  if (!config.webSocket) throw new Error('No linked edge WebSocket in /api/client-config');
  const url = `${config.webSocket.tls ? 'wss' : 'ws'}://${new URL(base).hostname}:${config.webSocket.port}/arena`;
  const ws = new WebSocket(url);
  const layers = createLayerDecoder(), frames = createFrameNormalizer();
  decoders.set(ws, layers);
  ws.on('message', (raw, binary) => {
    const data = readSocketMessage(raw, binary);
    if (data.type === 'seats') frames.seats(data.roster, data.revision);
    if (data.type === 'welcome' || data.type === 'ready') frames.envelope(data);
    if (data.type === 'state') layers.decode(data.state);
    if (data.state) data.state = frames.normalize(data.state);
    hydrated.set(ws, { raw, data });
  });
  await new Promise(resolve => ws.once('open', resolve));
  return ws;
}
/**
 * A private room whose map is ready. Rooms answer before their maps exist (#258); tests about other
 * things wait for it here, on the condition, under a generous cap: some seeds take tens of seconds (42).
 */
export async function createRoom(server, base, body) {
  const room = await (await fetch(base + '/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
  await server.rooms.get(room.id).ready; return room;
}
