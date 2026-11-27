// Generates live maps on a worker thread, so a room's map never stalls the tick loop of every other
// room (#253). The map, its portal graph (held beside it, 22.6) and the free-space tiles bots would
// build on their first plans go back packed (map-pack.js), so they transfer without a copy and no
// thread decodes them until the room that plays the map does (#1089).
import { parentPort } from 'node:worker_threads';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { prebuiltTiles } from '../shared/simulation/bot-routes.ts';
import { packMap, packedTransfer } from './map-pack.js';

parentPort.on('message', ({ id, seed, size }) => {
  try {
    const content = defaultContent(), map = generateLiveMap(seed, content, size);
    const packed = packMap(map, prebuiltTiles(map, content));
    parentPort.postMessage({ id, packed }, packedTransfer(packed));
  } catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
