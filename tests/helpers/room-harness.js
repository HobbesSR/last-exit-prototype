import { createRoomService } from '../../server/room-service.js';
import { createRoomDirectory } from '../../server/room-directory.js';
import { createLayerDecoder } from '../../shared/frame-layers.ts';

export function roomHarness({ finalize, reportError, startWriter, generateMap, pool, ...serviceOptions } = {}) {
  let wall = 1000, monotonic = 0;
  const writers = new Map();
  const replays = { start(header, options) {
    if (startWriter) { const writer = startWriter(header, options); writers.set(header.id, writer); return writer; }
    const writer = { header: structuredClone(header), frames: [], marks: [], blocked: false, finishCalls: 0,
      append(state, commands) { this.frames.push(structuredClone({ state, commands })); },
      mark(marker) { this.marks.push(structuredClone(marker)); return true; },
      async finish(result) {
        this.finishCalls++;
        if (finalize) await finalize(header.id);
        return { id: header.id, ...result, frames: this.frames.length };
      }
    };
    writers.set(header.id, writer); return writer;
  } };
  const service = createRoomService({ replays, wallNow: () => wall, reportError, ...serviceOptions });
  const directory = createRoomDirectory({ host: service, generateMap, pool, devTools: serviceOptions.devTools });
  const peer = () => {
    const messages = [], closes = [], layers = createLayerDecoder();
    // Frames are kept decoded, as the client reads them, and `sizes` keeps what each payload weighed.
    const deliver = payload => { const data = JSON.parse(payload); if (data.type === 'state') layers.decode(data.state); messages.push(data); sizes.push(payload.length); };
    const sizes = [];
    const session = service.connect({ deliver, close: (...args) => { closes.push(args); service.disconnect(session); } });
    return { session, messages, sizes, closes, send: message => directory.receive(session, message) };
  };
  const joined = (room, extra = {}) => {
    const p = peer(); p.send({ type: 'join', room: room.id, ...extra }); return p;
  };
  return { service, directory, writers, peer, joined,
    wake(elapsed, wallElapsed = elapsed) { wall += wallElapsed; monotonic += elapsed; service.advance(elapsed, monotonic); },
    live(seed = 9) {
      const room = service.makeRoom(seed), owner = joined(room, { ownerKey: room.ownerKey });
      owner.send({ type: 'start' }); return { room, owner, writer: writers.get(room.id) };
    }
  };
}
