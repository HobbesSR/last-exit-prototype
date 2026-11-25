import { discoveryGrid } from '../discovery.ts';
import { navigationClearance } from '../map/navigation.ts';
import { freeTilesFor } from './knowledge.ts';
import { packRuntimeNavigation } from './runtime-map-write.js';
import type { CoreExports } from '../core.ts';
import type { CollisionMap, Role } from '../types.ts';

/** Upload and validate navigation. The returned handle owns its buffers until release. */
export function uploadRuntimeNavigation(core: CoreExports, map: CollisionMap,
  primaryBytes: Uint8Array | (() => Uint8Array), contestantBytes?: () => Uint8Array) {
  let primary = 0, contestant = 0, pointer = 0, released = false;
  let primaryLength = 0, contestantLength = 0;
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
    [primary, primaryLength] = upload(core, primaryBytes);
    if (contestantBytes) [contestant, contestantLength] = upload(core, contestantBytes);
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
  // Integral bounds keep every clipped point on the compact tile's exact coordinate grid.
  if (Number.isInteger(map.width) && Number.isInteger(map.height)) {
    const layer = (role: Role, includeGraph: boolean) =>
      packRuntimeNavigation(map, [freeTilesFor(map, role, false)], { compact: true, includeGraph });
    return uploadRuntimeNavigation(core, map, () => layer('gladiator', true), () => layer('contestant', false));
  }
  const layers = (['gladiator', 'contestant'] as const).map(role => freeTilesFor(map, role, false));
  return uploadRuntimeNavigation(core, map, packRuntimeNavigation(map, layers));
}

function upload(core: CoreExports, source: Uint8Array | (() => Uint8Array)): [number, number] {
  const bytes = typeof source === 'function' ? source() : source;
  const pointer = core.core_alloc(bytes.byteLength) >>> 0;
  if (!pointer) throw new RangeError('could not allocate runtime navigation');
  try {
    new Uint8Array(core.memory.buffer, pointer, bytes.byteLength).set(bytes);
    return [pointer, bytes.byteLength];
  } catch (error) {
    core.core_free(pointer, bytes.byteLength);
    throw error;
  }
}
