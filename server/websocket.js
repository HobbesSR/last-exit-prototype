import { WebSocket, WebSocketServer } from 'ws';
import { CLOSE_CODE, CLOSE_REASON, MAX_MESSAGE_BYTES, deliverable, parseMessage, acceptMessageRate } from './protocol.js';

export function attachWebSockets(http, service) {
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_MESSAGE_BYTES });
  wss.on('error', error => { if (error.code !== 'EADDRINUSE') console.error(error); });
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return ws.close(CLOSE_CODE.POLICY_VIOLATION, CLOSE_REASON.ORIGIN_REJECTED); }
      catch { return ws.close(CLOSE_CODE.POLICY_VIOLATION); }
    }
    const session = service.connect({
      // Says whether the payload went, so a skipped state frame is known not to have delivered a keyframe.
      // A payload may come as UTF-8 bytes (from a room on its own thread, #1089); it is still a text frame.
      deliver: (payload, droppable = false) => {
        if (ws.readyState !== WebSocket.OPEN || !deliverable(ws.bufferedAmount, droppable)) return false;
        ws.send(payload, { binary: false }); return true;
      },
      bytes: true,
      buffered: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason)
    });
    const rate = { start: Date.now(), messages: 0 };
    ws.on('message', raw => {
      if (!acceptMessageRate(rate, Date.now())) return ws.close(CLOSE_CODE.POLICY_VIOLATION, CLOSE_REASON.RATE_EXCEEDED);
      let data;
      try { data = parseMessage(raw); } catch { return ws.close(CLOSE_CODE.POLICY_VIOLATION, CLOSE_REASON.INVALID_MESSAGE); }
      service.receive(session, data);
    });
    ws.on('close', () => service.disconnect(session));
    ws.on('error', () => {});
  });
  return wss;
}
