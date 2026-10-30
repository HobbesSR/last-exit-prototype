import type { Game, Gate } from '../types.ts';

// Gates follow the shared-frame model (#655 stage 2, 22.1 "Frames") from the frame's side. Rules and tests open,
// close and unlock live gates in place, and physics pins the live list, so a frame cannot hold the live records.
// It holds frozen copies instead: one per gate, made again only when that gate's fields differ from it, in a list
// that is the last frame's list itself when no gate changed. Gates are flat, so a copy is a spread.

/** Each live gate's last frozen copy. */
const copies = new WeakMap<Gate, Gate>();
/** The last frame list made from each live list. */
const frames = new WeakMap<readonly Gate[], readonly Gate[]>();
/** Lists a frame holds. Marked, not frozen: V8 walks a frozen array more slowly in `filter` and `JSON.stringify`. */
const published = new WeakSet<readonly Gate[]>();

/** Whether `copy` still has every field of `gate`, in the same order, with the same values. */
function current(copy: Gate, gate: Gate): boolean {
  const keys = Object.keys(copy), live = Object.keys(gate);
  if (keys.length !== live.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]! as keyof Gate;
    if (key !== live[i] || !Object.is(copy[key], gate[key])) return false;
  }
  return true;
}

/** The frame's gate list: the last one when no gate changed, else one that shares every unchanged copy. */
export function publishGates(s: Game): readonly Gate[] {
  const live = s.map.gates, last = frames.get(live), list: Gate[] = new Array(live.length);
  let changed = last?.length !== live.length;
  for (let i = 0; i < live.length; i++) {
    const gate = live[i]!;
    let copy = copies.get(gate);
    if (!copy || !current(copy, gate)) copies.set(gate, copy = Object.freeze({ ...gate }));
    list[i] = copy;
    if (!changed && last![i] !== copy) changed = true;
  }
  if (!changed) return last!;
  frames.set(live, list); published.add(list);
  return list;
}

/** Whether `list` is one `publishGates` made, which never changes. */
export const publishedGates = (list: readonly Gate[]): boolean => published.has(list);

const listJson =new WeakMap<readonly Gate[], string>(), recordJson = new WeakMap<Gate, string>();

/** `JSON.stringify(list)`, kept per published list and per copy, since neither changes once made. Any other list is serialized whole. */
export function gatesJson(list: readonly Gate[]): string {
  if (!published.has(list)) return JSON.stringify(list);
  let json = listJson.get(list);
  if (json === undefined) listJson.set(list, json = `[${list.map(recordText).join(',')}]`);
  return json;
}

function recordText(gate: Gate): string {
  let json = recordJson.get(gate);
  if (json === undefined) recordJson.set(gate, json = JSON.stringify(gate));
  return json;
}
