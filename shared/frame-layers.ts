// How a live state frame carries the map's slow-changing collections: as tables sent whole once and then
// as changes against that whole copy, rather than in full every tick (#250).
//
// Items and gates are nearly static. A directed view carries every one on the map, about 98 KB and 12 KB
// of a 113 KB frame, while a few of them change in a typical tick. Each is a layer, independent of the
// other and of the rest of the frame, which is still sent whole: a layer may be on a different version
// from its neighbour and nothing reads across them.
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
//   [ ... ]                        a plain list, as before: waiting frames, welcomes, recordings
//   { k, set?: [ ... ], drop?: [ids] }   keyframe k with these entries replaced or added, and these removed
//   { k, all: [ ... ], set?, drop? }     the same, carrying keyframe k itself for a session that lacks it
// A keyframe never changes once cut: `all` is always the layer as it was then, and the current frame is
// that plus the same changes every other session on the view is sent.
// Keyframe numbers are unique in the process, so one never matches a table from another view or room.

export const LAYERS = ['items', 'gates'] as const;
export type Layer = typeof LAYERS[number];
type Id = string | number;
type Entry = { id: Id };
export type LayerWire = Entry[] | { k: number; all?: Entry[]; set?: Entry[]; drop?: Id[] };

// A keyframe is cut once the change set reaches this share of the layer (or a floor, for small layers):
// past it, re-sending the whole layer once costs less than carrying the changes every tick.
const REKEY_SHARE = 1 / 32, REKEY_FLOOR = 16;
let versions = 0;

type Table = { k: number; all: Entry[]; ids: Id[]; byId: Map<Id, Entry> };
export type EncodedLayer = { k: number; all: () => LayerWire; changes: LayerWire } | { plain: Entry[] };

/** The server's side, one per view: what each layer is relative to, and both forms of it. */
export function createLayerEncoder() {
  const tables = new Map<Layer, Table>();
  function encodeLayer(layer: Layer, list: Entry[]): EncodedLayer {
    let table = tables.get(layer);
    const changes = table && changesSince(table, list);
    if (!changes) {
      const byId = new Map(list.map(entry => [entry.id, entry]));
      // Entries without distinct ids cannot be addressed by a change, so that layer goes whole.
      if (byId.size !== list.length || byId.has(undefined as never)) { tables.delete(layer); return { plain: list }; }
      tables.set(layer, table = { k: ++versions, all: list, ids: list.map(entry => entry.id), byId });
    }
    const { k, all } = table!, current = changes ?? { k };
    return { k, all: () => ({ ...current, all }), changes: current };
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
function changesSince(table: Table, list: Entry[]) {
  const set: Entry[] = [], drop: Id[] = [], present = new Set<Id>();
  const budget = Math.max(REKEY_FLOOR, table.ids.length * REKEY_SHARE);
  for (const entry of list) { present.add(entry.id); if (!same(table.byId.get(entry.id), entry)) set.push(entry); }
  if (present.size !== list.length) return null;
  for (const id of table.ids) if (!present.has(id)) drop.push(id);
  if (set.length + drop.length > budget) return null;
  let at = 0;
  for (const id of table.ids) if (present.has(id) && list[at++]!.id !== id) return null;
  for (; at < list.length; at++) if (table.byId.has(list[at]!.id)) return null;
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
  const tables = new Map<Layer, { k: number; all: Entry[]; last: Entry[] }>();
  return {
    decode<T extends Record<string, unknown>>(state: T): T & { stale?: Layer[] } {
      const stale: Layer[] = [];
      for (const layer of LAYERS) {
        const wire = state[layer] as LayerWire | undefined;
        if (!wire || Array.isArray(wire)) continue;
        let list: Entry[];
        if (wire.all) tables.set(layer, { k: wire.k, all: wire.all, last: wire.all });
        const table = tables.get(layer);
        if (!table || table.k !== wire.k) { stale.push(layer); list = table?.last ?? []; }
        else table.last = list = rebuild(table.all, wire.set, wire.drop);
        (state as Record<string, unknown>)[layer] = list;
      }
      return stale.length ? Object.assign(state, { stale }) : state;
    }
  };
}

function rebuild(all: Entry[], set: Entry[] = [], drop: Id[] = []) {
  // A copy even when nothing changed: the keyframe is kept for later frames, and a reader may reorder its list.
  if (!set.length && !drop.length) return all.slice();
  const gone = new Set(drop), changed = new Map(set.map(entry => [entry.id, entry]));
  const list: Entry[] = [];
  for (const entry of all) if (!gone.has(entry.id)) { list.push(changed.get(entry.id) ?? entry); changed.delete(entry.id); }
  for (const entry of changed.values()) list.push(entry);
  return list;
}
