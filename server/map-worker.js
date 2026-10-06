// Generates live maps on a worker thread, so a room's map never stalls the tick loop of every other
// room (#253). A map is plain data, so it crosses back to the main thread exactly as generated.
import { parentPort } from 'node:worker_threads';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';

parentPort.on('message', ({ id, seed, size }) => {
  try { parentPort.postMessage({ id, map: generateLiveMap(seed, defaultContent(), size) }); }
  catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
