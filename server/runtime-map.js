import { initCore } from '../shared/core.ts';
import { freeTilesFor } from '../shared/navigation/knowledge.ts';
import { createRuntimeNavigation, uploadRuntimeNavigation } from '../shared/navigation/runtime-map.ts';
import { takeRuntimeNavigation } from './map-pack.js';
import { packRuntimeNavigation } from './runtime-map-write.js';

/** Prepare both navigation layers before the room is ready. */
export async function prepareRuntimeNavigation(map) {
  const pending = takeRuntimeNavigation(map);
  const core = await initCore();
  if (!pending) return createRuntimeNavigation(core, map);
  const contestant = pending.deferContestant
    ? () => packRuntimeNavigation(map, [freeTilesFor(map, 'contestant', false)], { compact: true, includeGraph: false })
    : undefined;
  return uploadRuntimeNavigation(core, map, pending.bytes, contestant);
}
