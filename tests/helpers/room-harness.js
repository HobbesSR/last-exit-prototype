import { createRoomService } from '../../server/room-service.js';

export function roomHarness({ finalize, reportError } = {}) {
  let wall = 1000, monotonic = 0;
  const writers = new Map();
  const replays = { start(header) {
    const writer = { header: structuredClone(header), frames: [], blocked: false, finishCalls: 0,
      append(state, commands) { this.frames.push(structuredClone({ state, commands })); },
      async finish(result) {
        this.finishCalls++;
        if (finalize) await finalize(header.id);
        return { id: header.id, ...result, frames: this.frames.length };
      }
    };
    writers.set(header.id, writer); return writer;
  } };
  const service = createRoomService({ replays, wallNow: () => wall, reportError });
  const peer = () => {
    const messages = [], closes = [];
    const session = service.connect({ deliver: payload => messages.push(JSON.parse(payload)), close: (...args) => { closes.push(args); service.disconnect(session); } });
    return { session, messages, closes, send: message => service.receive(session, message) };
  };
  const joined = (room, extra = {}) => {
    const p = peer(); p.send({ type: 'join', room: room.id, ...extra }); return p;
  };
  return { service, writers, peer, joined,
    wake(elapsed, wallElapsed = elapsed) { wall += wallElapsed; monotonic += elapsed; service.advance(elapsed, monotonic); },
    live(seed = 9) {
      const room = service.makeRoom(seed), owner = joined(room, { ownerKey: room.ownerKey });
      owner.send({ type: 'start' }); return { room, owner, writer: writers.get(room.id) };
    }
  };
}
