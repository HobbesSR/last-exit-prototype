// Generates live maps on a worker thread, so a room's map never stalls the tick loop of every other
// room (#253). A map is plain data, so it crosses back to the main thread exactly as generated. Its
// portal graph is held beside it rather than in it (22.6), so it is posted alongside.
import { parentPort } from 'node:worker_threads';
import { generateLiveMap } from '../map/live.ts';
import { defaultContent } from '../shared/simulation/content.ts';
import { portalGraphOf } from '../shared/navigation/portal-graph.ts';

parentPort.on('message', ({ id, seed, size }) => {
  try { const map = generateLiveMap(seed, defaultContent(), size); parentPort.postMessage({ id, map, navigation: portalGraphOf(map) }); }
  catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
