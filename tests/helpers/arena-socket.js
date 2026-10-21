import { WebSocket } from 'ws';
import { createLayerDecoder } from '../../shared/frame-layers.ts';

/**
 * What the end-to-end server suites share for talking to a live arena over its socket and HTTP API.
 * Each suite still arranges and asserts its own scenario; only the waiting and room setup live here.
 */

// A socket's layer decoder; a state frame read here is decoded as the client would (#250). Frames that
// arrive while nothing waits are not decoded, so read layers only from a session's first frame or keyframes.
const decoders = new WeakMap();
/**
 * The next message of `type` that `accept` takes. It stops listening once it settles, whether it is
 * answered or times out, so a failed wait leaves nothing behind on the socket.
 */
export function next(ws, type, timeoutMs = 5000, accept = () => true) {
  if (!decoders.has(ws)) decoders.set(ws, createLayerDecoder());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    function receive(raw) {
      const data = JSON.parse(raw);
      if (data.type === 'state') decoders.get(ws).decode(data.state);
      if (data.type === type && accept(data)) { clearTimeout(timer); ws.off('message', receive); resolve(data); }
    }
    ws.on('message', receive);
  });
}
/** A socket to the arena at `base` (its http URL), once open. */
export async function open(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:')); await new Promise(resolve => ws.once('open', resolve));
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
