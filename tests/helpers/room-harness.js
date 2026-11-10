import { createRoomService } from '../../server/room-service.js';
import { createRoomDirectory } from '../../server/room-directory.js';
import { createLayerDecoder } from '../../shared/frame-layers.ts';
import { generateLiveMap, DEFAULT_LIVE_ZONE_SIZE, zoneSizeName } from '../../map/live.ts';
import { defaultContent } from '../../shared/simulation/content.ts';
import { attachPortalGraph, portalGraphOf } from '../../shared/navigation/portal-graph.ts';
import { ARENA_SEED, readArena } from '../../tools/room-arena.mjs';

// These tests are about room policy with a fake clock, on the shipped content and the engine it runs (#920).
// A physics match is built asynchronously, so a room is usable once `room.ready` settles: `room()`, `live()`
// and `created()` wait for it, and a test that drives the directory itself awaits `room.ready`.

const generated = new Map();
/**
 * The live map for a seed and size, generated once per test file, as a fresh copy each call.
 * Seed 9 at the default size, which every room test plays on, is read from the pregenerated
 * arena instead (`tools/room-arena.mjs`, #849): these tests are about rooms, a 12 x 6 map takes
 * seconds to build, and `tests/slow/room-arena.test.js` checks the arena is still seed 9's map. Copying
 * is what a room is given anyway: the worker's map arrives structured-cloned (map-worker.js), so no
 * two rooms ever share one, and none can change the map another is given. The portal graph is kept
 * beside a map rather than in it (22.6) and a clone drops it, so each copy is given its own, as the
 * worker's answer is (map-generator.js): bots plan with it in every room that plays a live map.
 */
export function generatedMap(seed = 9, size = DEFAULT_LIVE_ZONE_SIZE) {
  const key = `${seed} ${zoneSizeName(size)}`;
  if (!generated.has(key)) {
    if (seed === ARENA_SEED && zoneSizeName(size) === zoneSizeName(DEFAULT_LIVE_ZONE_SIZE)) {
      const { map, graph } = readArena();
      attachPortalGraph(map, graph);
      generated.set(key, map);
    } else generated.set(key, generateLiveMap(seed, defaultContent(), size));
  }
  const original = generated.get(key), copy = structuredClone(original), graph = portalGraphOf(original);
  if (graph) attachPortalGraph(copy, structuredClone(graph));
  return copy;
}

/**
 * A `generateMap` answering every seed with a copy of seed 9's map, as `reuseMaps`' pool does: for tests
 * where a room's seed is only a label and need not be the seed of its map, so random or extra seeds
 * cost no generation. The room keeps the seed it was asked for.
 */
export const reusedMap = (_seed, size = DEFAULT_LIVE_ZONE_SIZE) => Promise.resolve(generatedMap(9, size));

/**
 * Fake time, peers and replay writers around a real room service and directory. `reuseMaps` is for
 * tests about room policy rather than maps: every room gets a copy of an already generated map, at
 * once as inline generation would, and a room that names no seed takes seed 9's, as from a pool.
 * Without it each room generates its own inline, or through the `generateMap` and `pool` given.
 */
export function roomHarness({ finalize, reportError, startWriter, generateMap, pool, reuseMaps = false, ...serviceOptions } = {}) {
  if (reuseMaps) {
    generateMap ??= generatedMap;
    pool ??= { take: size => ({ seed: 9, map: generatedMap(9, size) }) };
  }
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
  // A room with its match built: on a copy of the seed's shared map with `reuseMaps`, else generated inline.
  // It never asks `generateMap`, which only the directory's rooms use: with both set, `h.room()` still takes the copy.
  const room = async (seed = 9) => {
    const made = service.makeRoom(seed, false, DEFAULT_LIVE_ZONE_SIZE, reuseMaps ? generatedMap(seed) : undefined);
    await made.ready; return made;
  };
  return { service, directory, writers, peer, joined, room,
    /** A directory room (`createRoom`'s arguments), once its match is built. */
    async created(...args) { const made = directory.createRoom(...args); await made?.ready; return made; },
    wake(elapsed, wallElapsed = elapsed) { wall += wallElapsed; monotonic += elapsed; service.advance(elapsed, monotonic); },
    async live(seed = 9) {
      const made = await room(seed), owner = joined(made, { ownerKey: made.ownerKey });
      owner.send({ type: 'start' }); return { room: made, owner, writer: writers.get(made.id) };
    }
  };
}
