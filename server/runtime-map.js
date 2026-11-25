import { initCore } from '../shared/core.ts';
import { freeTilesFor } from '../shared/navigation/knowledge.ts';
import { createRuntimeNavigation, uploadRuntimeNavigation } from '../shared/navigation/runtime-map.ts';
import { takeRuntimeNavigation } from './map-pack.js';
import { packRuntimeNavigation } from './runtime-map-write.js';

// Both flat formats put the graph flag in section 0 and the same five graph sections after it.
function recordingGraph(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directoryEntry = section => 8 + section * 8;
  if (!view.getUint32(view.getUint32(directoryEntry(0), true), true)) return null;
  const sections = [];
  for (let section = 1; section <= 5; section++) {
    const entry = directoryEntry(section);
    const offset = view.getUint32(entry, true), length = view.getUint32(entry + 4, true);
    sections.push(Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).toString('base64'));
  }
  return { encoding: 'flat-graph-1', sections };
}

/** Prepare both navigation layers before the room is ready. */
export async function prepareRuntimeNavigation(map) {
  const pending = takeRuntimeNavigation(map);
  const core = await initCore();
  let portalGraph;
  const capture = bytes => { portalGraph = recordingGraph(bytes); };
  const contestant = pending?.deferContestant
    ? () => packRuntimeNavigation(map, [freeTilesFor(map, 'contestant', false)], { compact: true, includeGraph: false })
    : undefined;
  const navigation = pending
    ? uploadRuntimeNavigation(core, map, pending.bytes, contestant, capture)
    : createRuntimeNavigation(core, map, capture);
  return { ...navigation, portalGraph };
}
