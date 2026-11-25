import { initCore } from '../shared/core.ts';
import { freeTilesFor } from '../shared/navigation/knowledge.ts';
import { createRuntimeNavigation, uploadRuntimeNavigation } from '../shared/navigation/runtime-map.ts';
import { runtimePortalGraphSections } from '../shared/navigation/runtime-map-write.js';
import { hasRuntimeNavigation, takeRuntimeNavigation } from './map-pack.js';
import { packRuntimeNavigation } from './runtime-map-write.js';

function recordingGraph(bytes) {
  const graph = runtimePortalGraphSections(bytes);
  if (!graph) return null;
  const sections = graph.map(({ buffer, byteOffset, byteLength }) =>
    Buffer.from(buffer, byteOffset, byteLength).toString('base64'));
  return { encoding: 'flat-graph-1', sections };
}

function readRecordingGraph(graph) {
  if (graph == null) return graph;
  if (graph?.encoding !== 'flat-graph-1') throw new RangeError('Unsupported replay setup.portalGraph encoding');
  if (!Array.isArray(graph.sections)) throw new RangeError('Invalid replay setup.portalGraph sections');
  return graph.sections.map(section => {
    if (typeof section !== 'string') throw new RangeError('Invalid replay setup.portalGraph section');
    const bytes = Buffer.from(section, 'base64');
    if (bytes.toString('base64') !== section) throw new RangeError('Invalid replay setup.portalGraph base64');
    return bytes;
  });
}

/** Prepare both navigation layers before the room is ready. */
export async function prepareRuntimeNavigation(map, archivedGraph) {
  if (archivedGraph !== undefined && hasRuntimeNavigation(map)) {
    throw new RangeError('Replay setup.portalGraph conflicts with pending runtime navigation');
  }
  const pending = takeRuntimeNavigation(map);
  const core = await initCore();
  let portalGraph;
  const capture = bytes => { portalGraph = recordingGraph(bytes); };
  const contestant = pending?.deferContestant
    ? () => packRuntimeNavigation(map, [freeTilesFor(map, 'contestant', false)], { compact: true, includeGraph: false })
    : undefined;
  const navigation = pending
    ? uploadRuntimeNavigation(core, map, pending.bytes, contestant, capture)
    : createRuntimeNavigation(core, map, capture, readRecordingGraph(archivedGraph));
  return { ...navigation, portalGraph };
}
