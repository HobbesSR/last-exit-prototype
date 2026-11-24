import { initCore } from '../shared/core.ts';
import { borrowFreeTiles } from '../shared/free-space.ts';
import { freeTilesFor } from '../shared/navigation/knowledge.ts';
import { attachPortalGraph, detachPortalGraph } from '../shared/navigation/portal-graph.ts';
import { takeRuntimeNavigation } from './map-pack.js';
import { readRuntimeNavigation } from './runtime-map-read.js';
import { packRuntimeNavigation } from './runtime-map-write.js';

/** Prepare both layers before the room is ready, then lend their views to the planner. */
export function prepareRuntimeNavigation(map) {
  const pending = takeRuntimeNavigation(map);
  return pending ? uploadRuntimeNavigation(map, pending) : undefined;
}

async function uploadRuntimeNavigation(map, pending) {
  const core = await initCore();
  let worker, contestant, clearTiles;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTiles?.();
    if (worker?.graph) detachPortalGraph(map);
    contestant?.release();
    worker?.release();
  };
  try {
    worker = upload(core, map, pending.bytes, pending.graphIds, pending.deferContestant ? 'gladiator' : undefined);
    pending.bytes = undefined;
    if (pending.deferContestant) {
      const bytes = packRuntimeNavigation(map, [freeTilesFor(map, 'contestant')], { compact: true, includeGraph: false });
      contestant = upload(core, map, bytes, undefined, 'contestant');
    }
    clearTiles = borrowFreeTiles(map, (box, clearance) => worker.tile(box, clearance) ?? contestant?.tile(box, clearance));
    if (worker.graph) attachPortalGraph(map, worker.graph);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function upload(core, map, source, graphIds, singleRole) {
  const length = source.byteLength;
  let pointer = core.core_alloc(length) >>> 0;
  if (!pointer) throw new RangeError('could not allocate runtime navigation');
  let bytes;
  const currentBytes = () => {
    if (!pointer) throw new Error('runtime navigation has been released');
    const buffer = core.memory.buffer;
    if (bytes?.buffer !== buffer) bytes = new Uint8Array(buffer, pointer, length);
    return bytes;
  };
  const release = () => {
    if (!pointer) return;
    core.core_free(pointer, length);
    pointer = 0;
    bytes = undefined;
  };
  try {
    currentBytes().set(source);
    return { ...readRuntimeNavigation(map, currentBytes, graphIds, singleRole), release };
  } catch (error) {
    release();
    throw error;
  }
}
