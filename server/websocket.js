import { WebSocket, WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES, MAX_BUFFERED_BYTES, parseMessage, acceptMessageRate } from './protocol.js';

export function attachWebSockets(http, service) {
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });
  wss.on('error', error => { if (error.code !== 'EADDRINUSE') console.error(error); });
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return ws.close(1008, 'Origin rejected'); }
      catch { return ws.close(1008); }
    }
    const session = service.connect({
      deliver: payload => { if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < MAX_BUFFERED_BYTES) ws.send(payload); },
      close: (code, reason) => ws.close(code, reason)
    });
    const rate = { start: Date.now(), messages: 0 };
    ws.on('message', raw => {
      if (!acceptMessageRate(rate, Date.now())) return ws.close(1008, 'Input rate exceeded');
      let data;
      try { data = parseMessage(raw); } catch { return ws.close(1008, 'Invalid message'); }
      if (data) service.receive(session, data);
    });
    ws.on('close', () => service.disconnect(session));
    ws.on('error', () => {});
  });
  return wss;
}
