import { initCore } from '../shared/core.ts';
import { discoveryGrid } from '../shared/discovery.ts';
import { borrowFreeTiles } from '../shared/free-space.ts';
import { navigationClearance } from '../shared/map/navigation.ts';
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
  let worker, contestant, clearTiles, workerView;
  let pointer = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTiles?.();
    if (workerView?.graph) detachPortalGraph(map);
    worker?.release(!pointer);
    contestant?.release(!pointer);
    if (pointer) core.runtime_navigation_free(pointer);
  };
  try {
    worker = upload(core, pending.bytes);
    pending.bytes = undefined;
    if (pending.deferContestant) {
      const bytes = packRuntimeNavigation(map, [freeTilesFor(map, 'contestant')], { compact: true, includeGraph: false });
      contestant = upload(core, bytes);
    }
    const { size, cols, rows } = discoveryGrid(map);
    pointer = core.runtime_navigation_new(worker.pointer, worker.length, contestant?.pointer ?? 0, contestant?.length ?? 0,
      map.width, map.height, size, cols, rows, map.gates.length,
      navigationClearance('gladiator'), navigationClearance('contestant')) >>> 0;
    if (!pointer) throw new RangeError('Invalid runtime navigation (core)');
    workerView = readRuntimeNavigation(map, worker.currentBytes, pending.graphIds, contestant ? 'gladiator' : undefined);
    const contestantView = contestant && readRuntimeNavigation(map, contestant.currentBytes, undefined, 'contestant');
    clearTiles = borrowFreeTiles(map, (box, clearance) => workerView.tile(box, clearance) ?? contestantView?.tile(box, clearance));
    if (workerView.graph) attachPortalGraph(map, workerView.graph);
    return { pointer, release };
  } catch (error) {
    release();
    throw error;
  }
}

function upload(core, source) {
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
  const release = (free) => {
    if (!pointer) return;
    if (free) core.core_free(pointer, length);
    pointer = 0;
    bytes = undefined;
  };
  try {
    currentBytes().set(source);
    return { pointer, length, currentBytes, release };
  } catch (error) {
    release(true);
    throw error;
  }
}
