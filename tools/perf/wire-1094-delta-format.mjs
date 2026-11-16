// #1094 measurement code, not a protocol: a whole-projection delta against an acknowledged baseline frame,
// its exact inverse, and 24.1's candidate quantization applied before comparison.
//
// A message is { t, b, h?, u?, f? }:
//   t  the frame's tick; b the baseline tick it is relative to, or -1 for a whole frame
//   h  top-level fields that differ from the baseline (any value, compared as JSON would serialize it)
//   u  top-level fields the baseline had and this frame does not
//   f  per keyed family (a list whose entries all carry an id): { a?: added records, s?: changed records holding
//      only the changed fields plus id (and `u` for fields removed), d?: dropped ids, o?: the complete id order
//      when the rebuild rule below would not reproduce it }
// The rebuild rule is shared/keyed-list.ts's: baseline order, changed entries in place, new entries appended.
// A list of primitives that only grew (own discovery) travels as { append: [...] }.
// Fields whose value is undefined are absent, as JSON.stringify makes them.
import { rebuildKeyed } from '../../shared/keyed-list.ts';

const isKeyed = list => Array.isArray(list) && list.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id !== undefined);
const keysOf = value => Object.keys(value).filter(key => value[key] !== undefined);
// Structural equality as JSON would serialize it (undefined fields absent), without serializing.
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!sameValue(a[i] ?? null, b[i] ?? null)) return false; return true; }
  const ka = keysOf(a), kb = keysOf(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i] || !sameValue(a[ka[i]], b[ka[i]])) return false;
  return true;
}
const isPrimitiveList = list => Array.isArray(list) && list.every(v => v === null || typeof v !== 'object');
const isPrefix = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);

function fieldDelta(was, now) {
  const out = {}; let changed = false;
  for (const key of keysOf(now)) {
    if (key === 'id') continue;
    const x = was[key], y = now[key];
    if (sameValue(x, y)) continue;
    changed = true;
    out[key] = isPrimitiveList(x) && isPrimitiveList(y) && x.length < y.length && isPrefix(x, y) ? { append: y.slice(x.length) } : y;
  }
  const removed = keysOf(was).filter(key => now[key] === undefined);
  if (removed.length) { out.u = removed; changed = true; }
  return changed ? out : null;
}

/** Families: the keyed lists in either frame. Lists of anything else are header values. */
export function familiesOf(base, frame) {
  const names = new Set();
  for (const source of [base, frame]) if (source) for (const key of keysOf(source)) if (isKeyed(source[key]) && (!base || base[key] === undefined || isKeyed(base[key])) && (frame[key] === undefined || isKeyed(frame[key]))) names.add(key);
  return names;
}

/** The message carrying `frame` relative to `base` (null for a whole frame). `skip` names top-level fields left out. */
export function encodeDelta(base, frame, { t, b = -1, skip = new Set(), families = familiesOf(base, frame) } = {}) {
  const message = { t, b: base ? b : -1 }, h = {}, f = {};
  for (const key of keysOf(frame)) {
    if (skip.has(key)) continue;
    if (families.has(key)) {
      const list = frame[key], was = base?.[key];
      if (!was) { if (list.length) f[key] = { a: list }; else h[key] = list; continue; }
      const byId = new Map(was.map(entry => [entry.id, entry])), a = [], s = [], present = new Set();
      for (const entry of list) {
        present.add(entry.id);
        const old = byId.get(entry.id);
        if (!old) a.push(entry);
        else if (old !== entry) { const delta = fieldDelta(old, entry); if (delta) s.push({ id: entry.id, ...delta }); }
      }
      const d = was.filter(entry => !present.has(entry.id)).map(entry => entry.id);
      const family = { ...(a.length ? { a } : {}), ...(s.length ? { s } : {}), ...(d.length ? { d } : {}) };
      // The order a decoder would rebuild: baseline order without drops, then additions in frame order.
      const rebuilt = [...was.filter(entry => present.has(entry.id)).map(entry => entry.id), ...a.map(entry => entry.id)];
      if (rebuilt.some((id, i) => id !== list[i].id)) family.o = list.map(entry => entry.id);
      if (Object.keys(family).length) f[key] = family;
      continue;
    }
    if (!base || !sameValue(base[key], frame[key])) h[key] = frame[key];
  }
  const u = base ? keysOf(base).filter(key => !skip.has(key) && frame[key] === undefined) : [];
  if (Object.keys(h).length) message.h = h;
  if (u.length) message.u = u;
  if (Object.keys(f).length) message.f = f;
  return message;
}

/** The frame a client rebuilds from its copy of the baseline and a message. Exact inverse of encodeDelta. */
export function applyDelta(base, message) {
  const frame = {};
  if (message.b >= 0) for (const key of keysOf(base)) frame[key] = base[key];
  for (const key of message.u ?? []) delete frame[key];
  for (const [key, value] of Object.entries(message.h ?? {})) frame[key] = value;
  for (const [key, family] of Object.entries(message.f ?? {})) {
    const was = message.b >= 0 ? frame[key] ?? [] : [];
    const old = new Map(was.map(entry => [entry.id, entry]));
    const set = [...(family.s ?? []).map(change => {
      const entry = { ...old.get(change.id) };
      for (const [field, value] of Object.entries(change)) {
        if (field === 'id' || field === 'u') continue;
        entry[field] = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.append) && Object.keys(value).length === 1 ? [...entry[field], ...value.append] : value;
      }
      for (const field of change.u ?? []) delete entry[field];
      return entry;
    }), ...(family.a ?? [])];
    frame[key] = rebuildKeyed(was, entry => entry.id, set, family.d ?? [], family.o);
  }
  return frame;
}

// 24.1's candidate quanta, as integer units (the transmitted representation). Everything not named stays exact.
const TURN = 65536 / (2 * Math.PI);
const POSITION = { x: 256, y: 256 };
export const QUANTA = {
  players: { ...POSITION, heading: TURN },
  items: POSITION,
  traps: { ...POSITION, homeX: 256, homeY: 256, heading: TURN },
  projectiles: { ...POSITION, dx: 256, dy: 256 },
  effects: POSITION,
  bodies: { ...POSITION, angle: TURN, vx: 256, vy: 256, omega: 4096 },
  hookFlights: POSITION,
};
// A frozen projected record (items, gates) is shared by every view and frame that carries it (#655); its
// quantized copy is shared the same way, so retained history and identity comparison behave as they do exact.
const quantizedRecords = new WeakMap();
const quantizeRecord = (record, scales) => {
  if (Object.isFrozen(record)) {
    let cached = quantizedRecords.get(record);
    if (!cached) quantizedRecords.set(record, cached = Object.freeze(quantizeFields(record, scales)));
    return cached;
  }
  return quantizeFields(record, scales);
};
const quantizeFields = (record, scales) => {
  let out = record;
  for (const [field, scale] of Object.entries(scales)) {
    const v = record[field];
    if (typeof v !== 'number') continue;
    if (out === record) out = { ...record };
    out[field] = Math.round(v * scale);
  }
  return out;
};
/**
 * A copy of a projected frame with 24.1's candidate fields in integer quanta. Unchanged records keep identity per
 * call. `exact(family, record)` keeps a record unrounded (its own correction state, collision proxies).
 */
export function quantizeFrame(frame, exact = () => false) {
  const out = { ...frame };
  for (const [family, scales] of Object.entries(QUANTA)) if (Array.isArray(frame[family])) out[family] = frame[family].map(record => exact(family, record) ? record : quantizeRecord(record, scales));
  return out;
}
/**
 * What client prediction reads as collision state (public/physics-prediction.js): the viewer's own player record,
 * and every body without an item, since actors and solid props are proxy candidates and the own body is the actor.
 */
export const predictionDependency = viewer => (family, record) =>
  (family === 'players' && record.id === viewer) || (family === 'bodies' && record.itemId === undefined);
/** Message fields that are not part of the frame: used to train the meter's dictionary. */
export const ENVELOPE_KEYS = ['t', 'b', 'h', 'u', 'f', 'a', 's', 'd', 'o', 'append', 'sv'];
