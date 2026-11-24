import { serialize, deserialize } from 'node:v8';
import { attachPortalGraph, portalGraphOf } from '../shared/navigation/portal-graph.ts';
import { adoptPackedTiles } from '../shared/free-space.ts';
import { freeTilesFor } from '../shared/navigation/knowledge.ts';
import { packRuntimeNavigation } from './runtime-map-write.js';

// A generated map as bytes, so it can cross threads without any thread in between decoding it (#1089).
// Decoding a map's object graph costs the receiving thread 150-200 ms at 36x18, which on the host
// thread delays every room's delivery. The map and its portal graph (kept beside the map, 22.6) are
// one V8-serialized buffer; the free-space tiles bots plan on are already packed buffers. Every buffer
// is its own allocation, so all of them transfer rather than copy. Only the thread that runs the
// room unpacks it, and it unpacks it once: a packed map is consumed by its first transfer or unpack.
const PACKED = 'packed-map';
const pendingNavigation = new WeakMap();

// Bytes in their own ArrayBuffer: a pooled or offset Buffer would transfer (and detach) its neighbours too.
function owned(buffer) {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) return new Uint8Array(buffer.buffer);
  return new Uint8Array(buffer);
}

/** A map (with its portal graph and any prebuilt tiles) as transferable bytes. */
export function packMap(map, tiles = []) {
  return { kind: PACKED, bytes: owned(serialize({ map, navigation: portalGraphOf(map) ?? null })), tiles };
}

/** The opt-in worker handoff writes its flat navigation directly from generated tiles. */
export function packRuntimeMap(map) {
  const navigation = portalGraphOf(map) ?? null;
  const graphIds = navigation && { regions: navigation.regions.map(r => r.id), portals: navigation.portals.map(p => p.id) };
  const layers = ['gladiator', 'contestant'].map(role => freeTilesFor(map, role));
  return { kind: PACKED, bytes: owned(serialize({ map, graphIds })), tiles: [], runtimeNavigation: packRuntimeNavigation(map, layers) };
}

export const isPackedMap = value => value?.kind === PACKED && value.bytes instanceof Uint8Array;

/** The buffers to transfer with a packed map, each once: a copied or restored map's arrays may share one. */
export function packedTransfer(packed) {
  const buffers = packed.runtimeNavigation ? [packed.runtimeNavigation.buffer]
    : packed.tiles.flatMap(t => [t.index.buffer, t.floats.buffer, t.ints.buffer]);
  return [...new Set([packed.bytes.buffer, ...buffers])];
}

/** The map a packed map holds, with its portal graph and tiles attached as the generator left them. */
export function unpackMap(packed) {
  const { map, navigation, graphIds } = deserialize(packed.bytes);
  if (navigation) attachPortalGraph(map, navigation);
  for (const tile of packed.tiles) adoptPackedTiles(map, tile);
  if (packed.runtimeNavigation) pendingNavigation.set(map, { bytes: packed.runtimeNavigation, graphIds });
  return map;
}

/** Transfer the decoded envelope's navigation ownership to its only match. */
export function takeRuntimeNavigation(map) {
  const pending = pendingNavigation.get(map);
  pendingNavigation.delete(map);
  return pending;
}

/** A plain map as it is, a packed one unpacked: what a room in this thread is given. */
export const mapHere = map => isPackedMap(map) ? unpackMap(map) : map;
