// Keyed outward IDs (#1164, 24.4 "Keyed outward IDs"). Match-wide counters (bodies, tethers, items and
// `s.serial` for events, effects and projectiles) run for the whole match and are allocated before
// per-view filtering, so a client that saw them raw could count allocations it cannot see. Each outward
// ID instead passes through a keyed one-to-one mapping at the projection boundary. Internal IDs, their
// allocation order and every ordering that reads them stay as they are; recordings keep internal IDs.
//
// The mapping is a 4-round Feistel network over two halves of WIRE_ID_BITS, using only integer
// operations (Math.imul, xor, shifts) so Node and Chrome agree exactly. Outward IDs are non-zero (24.4),
// while `s.serial` starts at 0: an internal ID in [0, 2^BITS - 1) is shifted up by one into [1, 2^BITS),
// then permuted there, re-applying the network while it yields 0 (cycle-walking). A value outside the
// domain throws: a counter that outgrows it must fail loudly, never wrap into another ID.
//
// No key means the identity. Only the server's composition root draws a key (server/wire-key.js).

/** Outward IDs lie in [1, 2^WIRE_ID_BITS); internal ones in [0, WIRE_ID_LIMIT). Chosen from 36x18 bot-match maxima (24.4). */
export const WIRE_ID_BITS = 20;
/** One past the largest internal ID the mapping accepts. */
export const WIRE_ID_LIMIT = (1 << WIRE_ID_BITS) - 1;
const HALF = WIRE_ID_BITS / 2, MASK = (1 << HALF) - 1;
export const WIRE_ID_ROUNDS = 4;

/** Four 32-bit round keys. Never derived from the match seed or the gameplay RNG; never recorded or sent. */
export type WireIdKey = readonly number[];

/**
 * The counters whose IDs are mapped. Each has its own permutation, derived from the match key, so equal
 * internal values in two domains (body 7 and item 7) do not show as equal outward IDs.
 */
export const WIRE_ID_DOMAINS = ['item', 'body', 'tether', 'serial'] as const;
export type WireIdDomain = typeof WIRE_ID_DOMAINS[number];

export interface WireIds {
  /** True for the identity: callers skip mapping entirely, so unkeyed projection costs nothing. */
  readonly identity: boolean;
  /** The outward ID for an internal one of a domain. */
  readonly id: (value: number, domain: WireIdDomain) => number;
  /** The internal ID for an outward one (tests; and the input boundary should a client ever name one). */
  readonly internal: (value: number, domain: WireIdDomain) => number;
}

function round(r: number, k: number): number {
  let h = Math.imul(r ^ k, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca77); h ^= h >>> 13;
  return h & MASK;
}
function forward(value: number, keys: WireIdKey): number {
  let l = value >>> HALF, r = value & MASK;
  for (let i = 0; i < keys.length; i++) { const next = l ^ round(r, keys[i]!); l = r; r = next; }
  return (l << HALF) | r;
}
function backward(value: number, keys: WireIdKey): number {
  let l = value >>> HALF, r = value & MASK;
  for (let i = keys.length - 1; i >= 0; i--) { const prev = r ^ round(l, keys[i]!); r = l; l = prev; }
  return (l << HALF) | r;
}
function inDomain(value: number, low: number): void {
  if (!Number.isInteger(value) || value < low || value >= WIRE_ID_LIMIT + low)
    throw new RangeError(`ID ${value} is outside [${low}, ${WIRE_ID_LIMIT + low})`);
}

const IDENTITY: WireIds = Object.freeze({ identity: true, id: (value: number) => value, internal: (value: number) => value });

// One domain's round keys: each match key word mixed with the domain's tag (an integer finalizer).
function domainKeys(keys: WireIdKey, domain: number): readonly number[] {
  return Object.freeze(keys.map((k, i) => {
    let h = Math.imul(k ^ Math.imul(domain + 1, 0x9e3779b9) ^ i, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  }));
}

/** The mapping for one match (or waiting yard): the identity without a key. */
export function wireIds(key?: WireIdKey | null): WireIds {
  if (!key) return IDENTITY;
  if (key.length !== WIRE_ID_ROUNDS || !key.every(k => Number.isInteger(k) && k >= 0 && k <= 0xffffffff))
    throw new TypeError(`a wire ID key is ${WIRE_ID_ROUNDS} unsigned 32-bit integers`);
  const byDomain = Object.fromEntries(WIRE_ID_DOMAINS.map((domain, i) => [domain, domainKeys(key, i)])) as Record<WireIdDomain, readonly number[]>;
  const keysOf = (domain: WireIdDomain) => {
    const keys = byDomain[domain];
    if (!keys) throw new TypeError(`unknown wire ID domain ${String(domain)}`);
    return keys;
  };
  return Object.freeze({
    identity: false,
    id(value: number, domain: WireIdDomain) {
      const keys = keysOf(domain);
      inDomain(value, 0);
      let out = forward(value + 1, keys);
      while (out === 0) out = forward(out, keys);
      return out;
    },
    internal(value: number, domain: WireIdDomain) {
      const keys = keysOf(domain);
      inDomain(value, 1);
      let out = backward(value, keys);
      while (out === 0) out = backward(out, keys);
      return out - 1;
    },
  });
}

/** Map one declared field of a record when it holds a number; absent or non-numeric values pass. */
export function mapIdField(record: Record<string, unknown>, field: string, domain: WireIdDomain, wire: WireIds): void {
  const value = record[field];
  if (typeof value === 'number') record[field] = wire.id(value, domain);
}

/** Per-mapping caches, so a mapped record is built once per source record rather than once per view. */
const caches = new WeakMap<WireIds, Map<string, WeakMap<object, unknown>>>();
export function wireCache<K extends object, V>(wire: WireIds, name: string): WeakMap<K, V> {
  let byName = caches.get(wire);
  if (!byName) caches.set(wire, byName = new Map());
  let cache = byName.get(name);
  if (!cache) byName.set(name, cache = new WeakMap());
  return cache as WeakMap<K, V>;
}

const checkedFrames = new WeakSet<object>();
/**
 * Fail loudly when a frame's counters have outgrown the outward domain, keyed or not, so a run that never
 * maps (tests use the identity) still notices. Once per frame, not per view. `serial` and `itemSerial`
 * are the next IDs to allocate, so this fires one ID early, which the margin (24.4) makes harmless.
 */
export function assertWireDomain(frame: { serial?: number; itemSerial?: number | undefined; bodies?: readonly { id: number }[] | undefined; tethers?: readonly { id: number }[] | undefined; hookFlights?: readonly { id: number }[] | undefined }): void {
  if (checkedFrames.has(frame)) return;
  let max = Math.max(frame.serial ?? 0, frame.itemSerial ?? 0);
  for (const body of frame.bodies ?? []) if (body.id > max) max = body.id;
  for (const tether of frame.tethers ?? []) if (tether.id > max) max = tether.id;
  // A hook in flight holds a tether ID before any tether exists.
  for (const flight of frame.hookFlights ?? []) if (flight.id > max) max = flight.id;
  if (max >= WIRE_ID_LIMIT) throw new RangeError(`a match counter reached ${max}, outside the outward ID domain [0, ${WIRE_ID_LIMIT})`);
  checkedFrames.add(frame);
}
