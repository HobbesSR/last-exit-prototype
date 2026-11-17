// How a live state frame carries the map's slow-changing collections: as tables sent whole once and then
// as changes against that whole copy, rather than in full every tick.
//
// Items and gates are nearly static. A directed view carries every one on the map, most of a frame's
// bytes, while a few of them change in a typical tick. Each is a layer, independent of the
// other and of the rest of the frame, which is still sent whole: a layer may be on a different version
// from its neighbour and nothing reads across them.
// Physics bodies and tethers use the same mechanism. Moving entries participate in comparison
// every tick; a busy body layer simply rekeys when its changes exceed the ordinary budget.
//
// The scheme is the standard one for snapshot delta compression (Quake 3, Source, MPEG's I- and
// P-frames), shaped by two facts of this server:
// - A layer's change set is measured against its keyframe, not against the previous tick, so it is the
//   same for every session on that view and the payload stays shared (24: cost is per view, not per
//   socket). It grows until it is worth sending a new keyframe instead.
// - Sockets are ordered and reliable, so the only lost frame is one the server itself skipped for
//   backpressure, and the server knows which. A session is sent a keyframe whenever it has not been
//   delivered the current one: on joining, after a skip, or when a new keyframe is cut. There is no
//   periodic re-send (an MPEG carousel) because no receiver can be missing one without the server knowing.
//
// On the wire a layer is one of:
//   [ ... ]                        a plain list: waiting frames, welcomes, recordings
//   { k, set?: [ ... ], drop?: [ids] }   keyframe k with these entries replaced or added, and these removed
//   { k, all: [ ... ], set?, drop? }     the same, carrying keyframe k itself for a session that lacks it
// A keyframe never changes once cut: `all` is always the layer as it was then, and the current frame is
// that plus the same changes every other session on the view is sent.
// Keyframe numbers are unique in the process, so one never matches a table from another view or room.
// Contestant discovery uses the same delivery tracking and process-wide keyframe numbering through shared/discovery.ts.

import { count } from './profiler.ts';
import { rebuildKeyed, type Id } from './keyed-list.ts';

export const LAYERS = ['items', 'gates', 'bodies', 'tethers'] as const;
export type Layer = typeof LAYERS[number];
type Entry = { id?: Id; gateIdx?: number; generation?: number; shape?: unknown };
// Static gates use their canonical map slot; older plain/recorded gate lists retain ids.
const keyOf = (layer: Layer, entry: Entry): Id => (layer === 'gates' ? entry.gateIdx ?? entry.id : entry.id) as Id;
export type LayerWire = Entry[] | { k: number; all?: Entry[]; set?: Entry[]; drop?: Id[] };

// A keyframe is cut once the change set reaches this share of the layer (or a floor, for small layers):
// past it, re-sending the whole layer once costs less than carrying the changes every tick.
const REKEY_SHARE = 1 / 32, REKEY_FLOOR = 16;
let versions = 0;
export function nextVersion(): number { return ++versions; }

type Table = { k: number; all: Entry[]; ids: Id[]; byId: Map<Id, Entry>; last?: { list: Entry[]; encoded: EncodedLayer } };
export type EncodedLayer = { k: number; all: () => LayerWire; changes: LayerWire } | { plain: Entry[] };

/** Lists their owner never changes once made (a frame's gates, #655). Marked, not frozen, as ground-items explains. */
const settled = new WeakSet<readonly object[]>();
/** Promise that `list` and its entries will never change, so a layer given it again encodes as it did last time. */
export function settledLayer(list: readonly object[]): void { settled.add(list); }

/** The server's side, one per view: what each layer is relative to, and both forms of it. */
export function createLayerEncoder() {
  const tables = new Map<Layer, Table>();
  function encodeLayer(layer: Layer, list: Entry[]): EncodedLayer {
    let table = tables.get(layer);
    // The same settled list again: its change set against this keyframe is the one already worked out.
    if (table?.last?.list === list) return table.last.encoded;
    const changes = table && changesSince(layer, table, list);
    if (!changes) {
      count(`work.rekey.${layer}`);
      const byId = new Map(list.map(entry => [keyOf(layer, entry), entry]));
      // Entries without distinct ids cannot be addressed by a change, so that layer goes whole.
      if (byId.size !== list.length || byId.has(undefined as never)) { tables.delete(layer); return { plain: list }; }
      tables.set(layer, table = { k: nextVersion(), all: list, ids: list.map(entry => keyOf(layer, entry)), byId });
    }
    const { k, all } = table!, current = changes ?? { k }, encoded = { k, all: () => ({ ...current, all }), changes: current };
    if (settled.has(list)) table!.last = { list, encoded }; else delete table!.last;
    return encoded;
  }
  return {
    /** Each layer the frame holds, encoded; layers it does not hold are left out. */
    encode(frame: Record<string, unknown>) {
      const out: Partial<Record<Layer, EncodedLayer>> = {};
      for (const layer of LAYERS) if (Array.isArray(frame[layer])) out[layer] = encodeLayer(layer, frame[layer] as Entry[]);
      return out;
    }
  };
}

// The change set from a keyframe to this list, or null when a new keyframe is due: too many changes, or
// an order the decoder would not rebuild (it keeps the keyframe's order and appends new entries).
function changesSince(layer: Layer, table: Table, list: Entry[]) {
  const set: Entry[] = [], drop: Id[] = [], present = new Set<Id>();
  const budget = Math.max(REKEY_FLOOR, table.ids.length * REKEY_SHARE);
  for (const entry of list) {
    const id = keyOf(layer, entry), baseline = table.byId.get(id);
    present.add(id);
    if (!same(baseline, entry)) {
      // Shape belongs to this admission lifetime. New bodies/generations keep carrying it in
      // every delta until a keyframe includes them, even if an earlier delta sent the shape.
      if (layer === 'bodies' && baseline && baseline.generation === entry.generation) {
        const { shape: _shape, ...dynamic } = entry;
        set.push(dynamic);
      } else set.push(entry);
    }
  }
  if (present.size !== list.length) return null;
  for (const id of table.ids) if (!present.has(id)) drop.push(id);
  if (set.length + drop.length > budget) return null;
  let at = 0;
  for (const id of table.ids) if (present.has(id) && keyOf(layer, list[at++]!) !== id) return null;
  for (; at < list.length; at++) if (table.byId.has(keyOf(layer, list[at]!))) return null;
  return { k: table.k, ...set.length ? { set } : {}, ...drop.length ? { drop } : {} };
}

// Whether an entry serializes as its keyframe copy did: the same keys in the same order with equal values.
// Projected entries are flat, so a value that is an object is compared by its JSON.
function same(was: Entry | undefined, now: Entry) {
  if (!was) return false;
  if (was === now) return true;
  const a = Object.keys(was), b = Object.keys(now);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const key = a[i]!, x = (was as Record<string, unknown>)[key], y = (now as Record<string, unknown>)[key];
    if (key !== b[i]) return false;
    if (x !== y && !(typeof x === 'object' && typeof y === 'object' && JSON.stringify(x) === JSON.stringify(y))) return false;
  }
  return true;
}

/**
 * The client's side, one per socket. Turns each encoded layer back into the plain list the rest of the
 * client reads, in place. A change set against a keyframe it does not hold (which the server's delivery
 * tracking should never send) leaves the last list it had, and names the layer in `stale`.
 */
export function createLayerDecoder() {
  const tables = new Map<Layer, { k: number; all: Entry[]; byId: Map<Id, Entry>; last: Entry[] }>();
  return {
    decode<T extends Record<string, unknown>>(state: T): T & { stale?: Layer[] } {
      const stale: Layer[] = [];
      for (const layer of LAYERS) {
        const wire = state[layer] as LayerWire | undefined;
        if (!wire || Array.isArray(wire)) continue;
        let list: Entry[];
        if (wire.all) tables.set(layer, { k: wire.k, all: wire.all, byId: new Map(wire.all.map(entry => [keyOf(layer, entry), entry])), last: wire.all });
        const table = tables.get(layer);
        if (!table || table.k !== wire.k) { stale.push(layer); list = table?.last ?? []; }
        else table.last = list = rebuild(layer, table.all, table.byId, wire.set, wire.drop);
        (state as Record<string, unknown>)[layer] = list;
      }
      return stale.length ? Object.assign(state, { stale }) : state;
    }
  };
}

function rebuild(layer: Layer, all: Entry[], baseline: Map<Id, Entry>, set?: Entry[], drop?: Id[]) {
  if (layer === 'bodies' && set?.some(entry => !Object.hasOwn(entry, 'shape'))) {
    set = set.map(entry => {
      const was = baseline.get(keyOf(layer, entry));
      // Never borrow from the last decoded frame: it may be skipped, reordered by a
      // consumer, or hold a different generation that was introduced after this baseline.
      return !Object.hasOwn(entry, 'shape') && was && was.generation === entry.generation
        ? { ...entry, shape: was.shape } : entry;
    });
  }
  return rebuildKeyed(all, entry => keyOf(layer, entry), set, drop);
}
