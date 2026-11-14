// A list of records addressed by a unique id, rebuilt from an earlier copy and a change set. One owner for
// the rule, because the live wire's layers (frame-layers.ts) and recordings (recording-format.ts) must
// rebuild the same list from the same change in the same order.
//
// The order rule: entries keep the earlier copy's order, a changed entry keeps its place, removed ids
// leave, and entries new to the list follow in the order they were given. An encoder that needs any
// other order says so explicitly (`order`), or cuts a keyframe instead.

export type Id = string | number;

/**
 * `all` with the entries of `set` replaced or added and the ids in `drop` removed, by `keyOf`.
 * A new array even when nothing changed: the earlier copy is kept for later rebuilds, and a reader may
 * reorder the list it is given. `order`, when given, is the complete id order of the result.
 */
export function rebuildKeyed<T>(all: readonly T[], keyOf: (entry: T) => Id, set: readonly T[] = [], drop: readonly Id[] = [], order?: readonly Id[]): T[] {
  if (!set.length && !drop.length && !order) return all.slice();
  const gone = new Set(drop), changed = new Map(set.map(entry => [keyOf(entry), entry]));
  if (order) {
    const byId = new Map(all.map(entry => [keyOf(entry), entry]));
    return order.map(id => {
      const entry = changed.get(id) ?? (gone.has(id) ? undefined : byId.get(id));
      if (entry === undefined) throw new RangeError(`keyed list has no entry ${String(id)}`);
      return entry;
    });
  }
  const list: T[] = [];
  for (const entry of all) {
    const id = keyOf(entry);
    if (!gone.has(id)) { list.push(changed.get(id) ?? entry); changed.delete(id); }
  }
  for (const entry of changed.values()) list.push(entry);
  return list;
}
