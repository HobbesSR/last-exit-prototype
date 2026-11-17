import { createFrameNormalizer } from '../../shared/relational-frame.ts';
import { WebSocket } from 'ws';
import { createLayerDecoder } from '../../shared/frame-layers.ts';

/**
 * What the end-to-end server suites share for talking to a live arena over its socket and HTTP API.
 * Each suite still arranges and asserts its own scenario; only the waiting and room setup live here.
 */

// A socket's layer decoder; a state frame read here is decoded as the client would (#250). Frames that
// arrive while nothing waits are not decoded, so read layers only from a session's first frame or keyframes.
const decoders = new WeakMap(), hydrated = new WeakMap();
/**
 * The next message of `type` that `accept` takes. It stops listening once it settles, whether it is
 * answered or times out, so a failed wait leaves nothing behind on the socket.
 */
export function next(ws, type, timeoutMs = 5000, accept = () => true) {
  if (!decoders.has(ws)) decoders.set(ws, createLayerDecoder());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    function receive(raw) {
      const data = hydrated.get(ws)?.raw === raw ? hydrated.get(ws).data : JSON.parse(raw);
      if (data.type === type && accept(data)) { clearTimeout(timer); ws.off('message', receive); resolve(data); }
    }
    ws.on('message', receive);
  });
}
/** A socket to the arena at `base` (its http URL), once open. */
export async function open(base) {
  const ws = new WebSocket(base.replace('http:', 'ws:'));
  const layers = createLayerDecoder(), frames = createFrameNormalizer();
  decoders.set(ws, layers);
  ws.on('message', raw => {
    const data = JSON.parse(raw);
    if (data.type === 'seats') frames.seats(data.roster);
    if (data.type === 'welcome' || data.type === 'ready') { frames.seats(data.roster); frames.setMap(data.map); }
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
