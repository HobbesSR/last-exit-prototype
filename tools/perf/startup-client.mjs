// Socket clients live off the host loop: parsing a welcome must not stall its ticks.
import { parentPort } from 'node:worker_threads';
import { WebSocket } from 'ws';

const clients = new Map();
let nextClient = 0, closing = false;
const stamp = () => performance.timeOrigin + performance.now();
function waitFor(client, type, operation) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${type}`)), 30000);
    const finish = error => {
      clearTimeout(timer); client.waiters.delete(type);
      error ? reject(error) : resolve();
    };
    client.waiters.set(type, finish);
    try { operation(); } catch (error) { finish(error); }
  });
}
function fail(client, error) {
  for (const finish of [...client.waiters.values()]) finish(error);
  if (!closing) parentPort.postMessage({ event: 'error', error: String(error) });
}
async function run({ method, url, room, ownerKey, record, clientId }) {
  if (method === 'join') {
    const id = ++nextClient, ws = new WebSocket(url);
    const client = { ws, waiters: new Map(), record };
    clients.set(id, client);
    ws.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'state' && client.record)
          parentPort.postMessage({ event: 'receipt', atMs: stamp() });
        if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong', token: data.token }));
        if (data.type === 'error') return fail(client, new Error(data.message));
        client.waiters.get(data.type)?.();
      } catch (error) { fail(client, error); }
    });
    ws.on('error', error => fail(client, error));
    ws.on('close', (code, reason) => fail(client, new Error(`socket closed (${code} ${reason})`)));
    await waitFor(client, 'welcome', () => ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'join', room, mode: 'dev', ownerKey }));
    }));
    return id;
  }
  if (method === 'start') {
    const client = clients.get(clientId);
    await waitFor(client, 'state', () => client.ws.send(JSON.stringify({ type: 'start' })));
    return;
  }
  if (method === 'close') {
    closing = true;
    await Promise.all([...clients.values()].map(({ ws }) => new Promise(resolve => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => ws.terminate(), 1000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.terminate();
    })));
    clients.clear();
    return;
  }
  throw new Error(`unknown client method ${method}`);
}
parentPort.on('message', async request => {
  try { parentPort.postMessage({ id: request.id, value: await run(request) }); }
  catch (error) { parentPort.postMessage({ id: request.id, error: String(error) }); }
});
parentPort.postMessage({ event: 'ready' });
