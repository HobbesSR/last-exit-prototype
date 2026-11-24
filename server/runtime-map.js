import { initCore } from '../shared/core.ts';
import { borrowFreeTiles } from '../shared/free-space.ts';
import { attachPortalGraph, detachPortalGraph } from '../shared/navigation/portal-graph.ts';
import { takeRuntimeNavigation } from './map-pack.js';
import { readRuntimeNavigation } from './runtime-map-read.js';

/** Upload the worker's navigation package once, then let the transition planner borrow its views. */
export async function prepareRuntimeNavigation(map) {
  const pending = takeRuntimeNavigation(map);
  if (!pending) return undefined;
  const core = await initCore();
  const length = pending.bytes.byteLength;
  let pointer = core.core_alloc(length) >>> 0;
  if (!pointer) throw new RangeError('could not allocate runtime navigation');
  let bytes, clearTiles;
  const currentBytes = () => {
    if (!pointer) throw new Error('runtime navigation has been released');
    const buffer = core.memory.buffer;
    if (bytes?.buffer !== buffer) bytes = new Uint8Array(buffer, pointer, length);
    return bytes;
  };
  const release = () => {
    if (!pointer) return;
    clearTiles?.();
    detachPortalGraph(map);
    core.core_free(pointer, length);
    pointer = 0;
    bytes = undefined;
  };
  try {
    currentBytes().set(pending.bytes);
    pending.bytes = undefined;
    const { graph, tile } = readRuntimeNavigation(map, currentBytes, pending.graphIds);
    clearTiles = borrowFreeTiles(map, tile);
    if (graph) attachPortalGraph(map, graph);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
