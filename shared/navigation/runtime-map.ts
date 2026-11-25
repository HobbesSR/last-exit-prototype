import { discoveryGrid } from '../discovery.ts';
import { navigationClearance } from '../map/navigation.ts';
import { freeTilesFor } from './knowledge.ts';
import { packRuntimeNavigation } from './runtime-map-write.js';
import type { CoreExports } from '../core.ts';
import type { CollisionMap } from '../types.ts';

/** Upload and validate navigation. The returned handle owns its buffers until release. */
export function uploadRuntimeNavigation(core: CoreExports, map: CollisionMap, bytes: Uint8Array, contestantBytes?: Uint8Array) {
  const primaryLength = bytes.byteLength, contestantLength = contestantBytes?.byteLength ?? 0;
  let primary = 0, contestant = 0, pointer = 0, released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (pointer) core.runtime_navigation_free(pointer);
    else {
      if (primary) core.core_free(primary, primaryLength);
      if (contestant) core.core_free(contestant, contestantLength);
    }
  };
  try {
    primary = upload(core, bytes);
    if (contestantBytes) contestant = upload(core, contestantBytes);
    const { size, cols, rows } = discoveryGrid(map);
    pointer = core.runtime_navigation_new(primary, primaryLength, contestant, contestantLength,
      map.width, map.height, size, cols, rows, map.gates.length,
      navigationClearance('gladiator'), navigationClearance('contestant')) >>> 0;
    if (!pointer) throw new RangeError('Invalid runtime navigation (core)');
    return { pointer, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Build both layers and any attached graph for an in-process game. */
export function createRuntimeNavigation(core: CoreExports, map: CollisionMap) {
  const layers = (['gladiator', 'contestant'] as const).map(role => freeTilesFor(map, role, false));
  return uploadRuntimeNavigation(core, map, packRuntimeNavigation(map, layers));
}

function upload(core: CoreExports, bytes: Uint8Array): number {
  const pointer = core.core_alloc(bytes.byteLength) >>> 0;
  if (!pointer) throw new RangeError('could not allocate runtime navigation');
  try {
    new Uint8Array(core.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return pointer;
  } catch (error) {
    core.core_free(pointer, bytes.byteLength);
    throw error;
  }
}
