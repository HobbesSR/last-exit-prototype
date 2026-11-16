// #1130: semantic-exactness and malformed-input safety checks for a wire codec { encode(msg) => Uint8Array,
// decode(bytes) => msg }. Measurement code. The exported check functions use no Node-only APIs (the self-test at
// the bottom does, and only runs when this file is the entry point), so the module loads in a browser too.

// ---------------------------------------------------------------------------------------------- comparison

const show = v => {
  if (typeof v === 'string') return JSON.stringify(v) + (v.length < 40 ? ` (${[...v].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ')})` : ` (length ${v.length})`);
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v && typeof v === 'object') return `object{${Object.keys(v).length} keys}`;
  return String(v);
};
const kindOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** First difference between actual and expected as a path plus both values, or null. Browser-safe deep strict
 *  equality: Object.is for numbers, key order insignificant, a key holding undefined differs from a missing key. */
export function firstDifference(actual, expected, path = '$') {
  const ka = kindOf(actual), ke = kindOf(expected);
  if (ka !== ke) return `${path}: type ${ka} (${show(actual)}) vs expected ${ke} (${show(expected)})`;
  if (ka === 'array') {
    if (actual.length !== expected.length) return `${path}: length ${actual.length} vs expected ${expected.length}`;
    for (let i = 0; i < actual.length; i++) { const d = firstDifference(actual[i], expected[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (ka === 'object') {
    const own = o => Object.getOwnPropertyNames(o);
    for (const k of own(expected)) {
      if (!Object.hasOwn(actual, k)) return `${path}.${k}: missing, expected ${show(expected[k])}`;
      const d = firstDifference(actual[k], expected[k], `${path}.${k}`); if (d) return d;
    }
    for (const k of own(actual)) if (!Object.hasOwn(expected, k)) return `${path}.${k}: unexpected key${actual[k] === undefined ? ' present with value undefined' : ` with value ${show(actual[k])}`}`;
    return null;
  }
  if (ka === 'number') return Object.is(actual, expected) ? null : `${path}: ${show(actual)} vs expected ${show(expected)}`;
  return actual === expected ? null : `${path}: ${show(actual)} vs expected ${show(expected)}`;
}

const jsonReference = message => JSON.parse(JSON.stringify(message));

// ---------------------------------------------------------------------------------------------- specimens

/** Specimens derived from one real state message. expect: 'exact', or 'exact-or-refusal' where a codec may
 *  legitimately refuse (a refusal is recorded, not hidden). base is cloned, never mutated. */
export function semanticSpecimens(base) {
  const clone = v => structuredClone(v);
  const out = [];
  const add = (name, message, expect = 'exact') => out.push({ name, message, expect });
  // A state message carrying the given players and body list in place of the real ones.
  const state = (players, bodies) => {
    const m = clone(base); m.state.players = players;
    if (bodies !== undefined) m.state.bodies = bodies === null ? undefined : { k: 1, all: bodies };
    return m;
  };
  const body = (extra = {}) => ({ id: 'actor:c0', kind: 'actor', shape: { kind: 'circle', radius: 11.5 }, x: 1, y: 2, angle: 0, generation: 1, ...extra });
  const own = (extra = {}) => ({ id: 'c0', name: 'Mica', role: 'contestant', kit: 'warden', x: 1, y: 2, hp: 100, lastSeq: -1, ...extra });
  const item = (extra = {}) => ({ id: 7, x: 1, y: 2, kind: 'ammo', ...extra });
  const fieldSpecimens = (label, make, values, expect) => { for (const [n, v] of values) add(`${label}: ${n}`, make(v), expect?.(n) ?? 'exact'); };

  add('base message unchanged', clone(base));
  add('null inventory slots', state([own({ inventory: [null, item(), null, null, item({ id: 'item-9' }), null], selectedSlot: 1 })]));
  add('null reload, charging, respawnAt', state([own({ reload: null, charging: null, respawnAt: null })]));
  add('non-null reload, charging, respawnAt', state([own({ reload: { slot: 2, instanceId: 'inst-1', until: 120 }, charging: 'rail', respawnAt: 500 })]));
  add('own player with few fields', state([own()]));
  add('own player with only id', state([{ id: 'c0', lastSeq: 0 }]));
  add('observed player', state([{ id: 'c1', role: 'contestant', kit: 'warden', name: 'Juno', x: 5, y: 6, heading: 0, status: 'active', hp: 100, maxHp: 100, shield: 0, weapon: 0, cloak: 0, revealed: 0, seat: 1 }]));
  add('empty players list', state([]));
  add('body without vx vy omega sleeping', state([own()], [body()]));
  add('body with every optional field', state([own()], [body({ vx: 1.5, vy: -2.5, omega: 0.25, sleeping: true, actorId: 'c0', itemId: 'it-1', discontinuity: 'placed' })]));
  add('key present with value undefined (body.vx)', state([own()], [body({ vx: undefined })]));
  add('key present with value undefined (player.hp)', state([own({ hp: undefined })]));
  add('key present with value undefined (state.directed)', (() => { const m = state([own()]); m.state.directed = undefined; return m; })());
  add('body itemId as number', state([own()], [body({ itemId: 42 })]));
  add('body itemId as string', state([own()], [body({ itemId: '42' })]));
  add('body itemId as numeric-looking big string', state([own()], [body({ itemId: '9007199254740993' })]));
  add('item id numeric', state([own({ cell: item({ id: 5 }) })]));
  add('item id string', state([own({ cell: item({ id: 'five' }) })]));
  add('item id string "5"', state([own({ cell: item({ id: '5' }) })]));
  add('item id negative number', state([own({ cell: item({ id: -3 }) })]));
  add('body shapes box and convex', state([own()], [body({ shape: { kind: 'box', hx: 4, hy: 5 } }), body({ id: 'p', shape: { kind: 'convex', vertices: [{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 0, y: 2.5 }] } })]));
  add('discovered layer drop with mixed ids', state([own({ discovered: { k: 2, all: [1, 2, 3], set: [4], drop: [5, 'x'] } })]));

  const numbers = [['0', 0], ['-0', -0], ['1', 1], ['-1', -1], ['2**31', 2 ** 31], ['2**32+1', 2 ** 32 + 1], ['2**53-1', 2 ** 53 - 1],
    ['-(2**53-1)', -(2 ** 53 - 1)], ['0.1', 0.1], ['-0.1', -0.1], ['1e-300', 1e-300], ['5e-324', 5e-324], ['1.7976931348623157e308', 1.7976931348623157e308],
    ['float32-exact 1234.567', Math.fround(1234.567)], ['non-float32 double 1234.567', 1234.567], ['2**50', 2 ** 50], ['2**50+1', 2 ** 50 + 1], ['-2**50-1', -(2 ** 50) - 1],
    ['float32 max', 3.4028234663852886e38], ['float32 min subnormal', 1.401298464324817e-45], ['integer-valued float 1e21', 1e21], ['0.5', 0.5], ['-0.5', -0.5]];
  fieldSpecimens('number as body.x', v => state([own()], [body({ x: v })]), numbers);
  fieldSpecimens('number as ping rtt', v => ({ type: 'ping', token: 't', rtt: v }), numbers.slice(0, 8));
  add('ping rtt null', { type: 'ping', token: 'abc', rtt: null });
  add('ping rtt number', { type: 'ping', token: 'abc', rtt: 12.5 });
  add('ping rtt zero', { type: 'ping', token: '', rtt: 0 });
  add('input with every optional field', { type: 'input', seq: 9, x: 0.5, y: -1, aim: 3.14, attack: true, skill: false, interact: true, drop: false, sneak: true, reload: false,
    slot: 3, moveSlot: { from: 1, to: 2 }, dropAmmo: { family: 'rifle', count: 30 }, transit: 'door-1' });
  add('input minimal', { type: 'input', seq: 0 });
  add('input seq negative', { type: 'input', seq: -1 });
  add('input optional undefined', { type: 'input', seq: 1, x: undefined, attack: undefined });
  add('input extra unknown field', { type: 'input', seq: 1, extra: 5 }, 'exact-or-refusal');

  const strings = [['empty', ''], ['ASCII', 'hello world'], ['e-acute', 'é'], ['CJK', '日本'], ['astral emoji', '😀'], ['lone high surrogate', '\uD800'],
    ['lone low surrogate in text', 'a\uDC00b'], ['reversed pair', '\uDE00\uD83D'], ['NUL and controls', 'a\u0000b\u001f'], ['U+FFFD literal', '�'],
    ['line separators', '  '], ['BOM', '﻿x'], ['4096 chars (maxString)', 'x'.repeat(4096)], ['4097 chars', 'x'.repeat(4097)],
    ['5000-char name', 'n'.repeat(5000)], ['1500 CJK chars (4500 UTF-8 bytes)', '日'.repeat(1500)]];
  const strExpect = n => /4097|5000|4500/.test(n) ? 'exact-or-refusal' : 'exact';
  fieldSpecimens('string as player name', v => state([own({ name: v })]), strings, strExpect);
  fieldSpecimens('string as ping token', v => ({ type: 'ping', token: v, rtt: null }), strings, strExpect);
  add('string as body id (id type, lone surrogate)', state([own()], [body({ id: 'a\uD800' })]));
  add('reserves map with __proto__ and constructor', state([own({ reserves: JSON.parse('{"__proto__": 1, "constructor": 2, "toString": 3, "rifle": 4}') })]));
  add('reserves map empty', state([own({ reserves: {} })]));
  add('reserves map key with lone surrogate and empty key', state([own({ reserves: JSON.parse('{"": 1, "\\ud800": 2}') })]));
  add('reserves map with undefined value', state([own({ reserves: { a: 1, b: undefined } })]));
  add('large players list (200 observed)', state(Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, role: 'contestant', kit: 'warden', name: `P${i}`, x: i, y: i * 2, heading: 0, status: 'active', hp: 100, maxHp: 100, shield: 0, weapon: 0, cloak: 0, revealed: 0 }))));
  return out;
}

// ---------------------------------------------------------------------------------------------- semantics

/** Encode then decode every specimen and compare with the JSON round trip of the message. */
export function checkSemantics(codec, specimens) {
  return specimens.map(({ name, message, expect }) => {
    const row = { name, expect, outcome: 'exact', detail: '' };
    let bytes;
    try { bytes = codec.encode(message); } catch (e) { row.outcome = 'encode-refused'; row.detail = String(e?.message ?? e); return finish(row); }
    let decoded;
    try { decoded = codec.decode(bytes); } catch (e) { row.outcome = 'decode-refused'; row.detail = String(e?.message ?? e); return finish(row); }
    const diff = firstDifference(decoded, jsonReference(message));
    if (diff) { row.outcome = 'mismatch'; row.detail = diff; }
    return finish(row);
  });
  function finish(row) { row.ok = row.outcome === 'exact' || (row.expect === 'exact-or-refusal' && row.outcome.endsWith('-refused')); return row; }
}

// ---------------------------------------------------------------------------------------------- malformed

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One timed decode that cannot throw: { threw, value, error, ms, nonError }.
function attempt(codec, bytes) {
  const t0 = performance.now();
  try { const value = codec.decode(bytes); return { threw: false, value, ms: performance.now() - t0 }; }
  catch (e) { return { threw: true, error: e, ms: performance.now() - t0, nonError: !(e instanceof Error) }; }
}

const tally = () => ({ cases: 0, threw: 0, returned: 0, maxMs: 0, nonError: 0, errors: {}, firstReturned: [] });
function record(t, r, label) {
  t.cases++; if (r.ms > t.maxMs) t.maxMs = r.ms;
  if (r.threw) {
    t.threw++; if (r.nonError) t.nonError++;
    const key = r.nonError ? `non-Error ${typeof r.error}` : `${r.error.name}: ${r.error.message}`.slice(0, 80);
    t.errors[key] = (t.errors[key] ?? 0) + 1;
  } else { t.returned++; if (t.firstReturned.length < 5) t.firstReturned.push(label); }
}

export function checkMalformed(codec, samples, { seed = 1130, corruptions = 2000, crafted = [] } = {}) {
  const rand = mulberry32(seed);
  const out = { truncation: tally(), trailingByte: tally(), header: { wrongFormat: tally(), wrongVersion: tally(), unknownMessageId: tally() },
    corruption: { cases: 0, threw: 0, returnedDifferent: 0, returnedIdentical: 0, nonError: 0, maxMs: 0, errors: {} }, crafted: [], maxMs: 0 };
  const originals = samples.map(s => { try { return codec.decode(s); } catch { return undefined; } });

  samples.forEach((bytes, si) => {
    const len = bytes.length, step = len > 4000 ? len / 4000 : 1;
    const seen = new Set();
    for (let f = 0; f < len; f += step) {
      const i = Math.floor(f); if (seen.has(i)) continue; seen.add(i);
      record(out.truncation, attempt(codec, bytes.slice(0, i)), `sample ${si} cut at ${i}/${len}`);
    }
    const extra = new Uint8Array(len + 1); extra.set(bytes); extra[len] = 0;
    record(out.trailingByte, attempt(codec, extra), `sample ${si} +1 byte`);
    for (const [slot, idx, valueOf] of [['wrongFormat', 0, b => b ^ 0xff], ['wrongVersion', 1, b => (b + 1) & 0x7f], ['unknownMessageId', 2, () => 0x7f]]) {
      const c = bytes.slice(); c[idx] = valueOf(c[idx]);
      record(out.header[slot], attempt(codec, c), `sample ${si} ${slot}`);
    }
  });

  for (let n = 0; n < corruptions && samples.length; n++) {
    const si = Math.floor(rand() * samples.length), c = samples[si].slice(), flips = 1 + Math.floor(rand() * 4);
    for (let f = 0; f < flips; f++) { const at = Math.floor(rand() * c.length), mask = 1 + Math.floor(rand() * 255); c[at] ^= mask; }
    const r = attempt(codec, c), k = out.corruption;
    k.cases++; if (r.ms > k.maxMs) k.maxMs = r.ms;
    if (r.threw) {
      k.threw++; if (r.nonError) k.nonError++;
      const key = r.nonError ? `non-Error ${typeof r.error}` : `${r.error.name}: ${r.error.message}`.slice(0, 80);
      k.errors[key] = (k.errors[key] ?? 0) + 1;
    } else if (originals[si] !== undefined && firstDifference(r.value, originals[si]) === null) k.returnedIdentical++;
    else k.returnedDifferent++;
  }

  for (const { name, bytes } of crafted) {
    const r = attempt(codec, bytes);
    out.crafted.push({ name, bytes: bytes.length, outcome: r.threw ? 'threw' : 'returned', ms: +r.ms.toFixed(3), nonError: r.nonError || undefined,
      error: r.threw ? (r.nonError ? `non-Error ${String(r.error)}` : `${r.error.name}: ${r.error.message}`.slice(0, 160)) : undefined });
  }

  const times = [out.truncation.maxMs, out.trailingByte.maxMs, ...Object.values(out.header).map(h => h.maxMs), out.corruption.maxMs, ...out.crafted.map(c => c.ms)];
  out.maxMs = +Math.max(0, ...times).toFixed(3);
  for (const t of [out.truncation, out.trailingByte, ...Object.values(out.header)]) t.maxMs = +t.maxMs.toFixed(3);
  out.corruption.maxMs = +out.corruption.maxMs.toFixed(3);
  return out;
}

// ---------------------------------------------------------------------------------------------- crafted inputs

const varint = n => { const b = []; while (n >= 0x80) { b.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); } b.push(n); return b; };
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const bytesOf = (...parts) => Uint8Array.from(parts.flat());
const MAX = 1 << 20;

/** Hostile inputs for kind 'descriptor' or 'msgpackr', as [{ name, bytes }]. The descriptor prefixes follow
 *  its Reader: header d1, varint version 1, varint message id 1 (state); State's optional mask is a varint
 *  (directed=1, contestantsActive=2, physicsProfile=4, bodies=8, ...), then version (str), tick (uint),
 *  phase (str), optionals in order, players (list: count varint), then bodies. A str is a varint
 *  length*2 (UTF-8) or length*2+1 (UTF-16 units) followed by the payload. Decoding is driven by the schema,
 *  so it cannot nest beyond the schema's own depth (limits.maxDepth is 12); there is no free-form recursion
 *  to attack, and the deepest legal path is crafted below as a bounded case. */
export function craftedInputs(kind) {
  if (kind === 'descriptor') {
    const head = [0xd1, 1, 1], base = mask => [...head, ...varint(mask), 0, 0, 0]; // empty version, tick 0, empty phase
    const big = [...varint(2 ** 31)];
    const oversize = new Uint8Array(MAX + 1); oversize.set([0xd1, 1, 1]);
    return [
      { name: 'players count 2**31, no payload', bytes: bytesOf(base(0), big) },
      { name: 'players count 2**31 with 16 bytes after', bytes: bytesOf(base(0), big, new Array(16).fill(1)) },
      { name: 'players count 65536 (at cap) with 3 bytes after', bytes: bytesOf(base(0), varint(65536), [0, 0, 0]) },
      { name: 'players count 65537 (above cap) with 70000 bytes after', bytes: bytesOf(base(0), varint(65537), new Array(70000).fill(0)) },
      { name: 'players count 40000 of empty Observed with matching zeros (cheap loop)', bytes: bytesOf(base(0), varint(40000), new Array(40000).fill(0)) },
      { name: 'bodies list count 2**31 (layer tag 0)', bytes: bytesOf(base(8), [0], [0], big) },
      { name: 'bodies layer all-count 2**31 (layer tag 3)', bytes: bytesOf(base(8), [0], [3], [0], big) },
      { name: 'version string length 2**31', bytes: bytesOf(head, [0], varint(2 ** 32), [0, 0]) },
      { name: 'version string UTF-16 length 2**31', bytes: bytesOf(head, [0], varint(2 ** 32 + 1)) },
      { name: 'version string length 4097 (just over maxString) with payload', bytes: bytesOf(head, [0], varint(4097 * 2), new Array(4097).fill(0x78), [0, 0]) },
      { name: 'varint of 10 continuation bytes', bytes: bytesOf(head, new Array(10).fill(0xff), [0]) },
      { name: 'varint above 2**53', bytes: bytesOf(head, [0], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]) },
      { name: 'presence mask with all bits set', bytes: bytesOf(head, varint(2 ** 40), [0, 0, 0]) },
      // Own has more than 26 optional fields, so its presence is two varint words (low, then high).
      { name: 'control: small valid message with an Own player (a decode is expected to succeed)', bytes: bytesOf(base(0), [1], [1], varint(1 << 3 | 0), [0], [0]) },
      { name: 'ping with token length 2**31', bytes: bytesOf([0xd1, 1, 2], varint(2 ** 32)) },
      { name: 'ping with huge declared length and 0 bytes', bytes: bytesOf([0xd1, 1, 2]) },
      { name: 'header only', bytes: bytesOf(head) },
      { name: 'empty input', bytes: new Uint8Array(0) },
      { name: '1 MiB + 1 bytes (expect refusal by size)', bytes: oversize },
    ];
  }
  if (kind === 'msgpackr') {
    const head = [0xd2, 1, 1];
    const nested = new Uint8Array(3 + 100000 + 1); nested.set(head); nested.fill(0x91, 3, 3 + 100000); nested[3 + 100000] = 0xc0;
    const nestedMap = new Uint8Array(3 + 3 * 30000 + 1); nestedMap.set(head);
    for (let i = 0; i < 30000; i++) nestedMap.set([0x81, 0xa1, 0x61], 3 + 3 * i); // {"a": {"a": ...
    nestedMap[nestedMap.length - 1] = 0xc0;
    const oversize = new Uint8Array(MAX + 1); oversize.set(head);
    const bin = new Uint8Array(3 + 5 + 16); bin.set(head); bin.set([0xc6, ...u32(0x7fffffff)], 3);
    return [
      { name: 'array32 length 0xffffffff, no payload', bytes: bytesOf(head, [0xdd], u32(0xffffffff)) },
      { name: 'array32 length 0xffffffff with 16 bytes', bytes: bytesOf(head, [0xdd], u32(0xffffffff), new Array(16).fill(0xc0)) },
      { name: 'array32 length 100000000 with 16 bytes', bytes: bytesOf(head, [0xdd], u32(100000000), new Array(16).fill(0xc0)) },
      { name: 'str32 length 0x7fffffff, no payload', bytes: bytesOf(head, [0xdb], u32(0x7fffffff)) },
      { name: 'str32 length 0xffffffff, no payload', bytes: bytesOf(head, [0xdb], u32(0xffffffff)) },
      { name: 'map32 length 0xffffffff, no payload', bytes: bytesOf(head, [0xdf], u32(0xffffffff)) },
      { name: 'map32 length 100000000 with 16 bytes', bytes: bytesOf(head, [0xdf], u32(100000000), new Array(16).fill(0xa1)) },
      { name: 'bin32 length 0x7fffffff with 16 bytes', bytes: bin },
      { name: 'ext32 length 0x7fffffff, type 0x72', bytes: bytesOf(head, [0xc9], u32(0x7fffffff), [0x72, 1, 2, 3]) },
      { name: 'ext32 length 0xffffffff, type 1', bytes: bytesOf(head, [0xc9], u32(0xffffffff), [1, 1, 2, 3]) },
      { name: 'uint64 0xffffffffffffffff', bytes: bytesOf(head, [0xcf], new Array(8).fill(0xff)) },
      { name: 'fixext1 record ref to undefined structure 0x40', bytes: bytesOf(head, [0xd4, 0x72, 0x40]) },
      { name: 'fixext1 record ref to undefined structure 0x20 (shared range)', bytes: bytesOf(head, [0xd4, 0x72, 0x20]) },
      { name: 'ext8 record definition, 255 keys, truncated', bytes: bytesOf(head, [0xc7, 0xff, 0x72, 0x40], new Array(20).fill(0xa1)) },
      { name: '100000 nested one-element arrays then nil', bytes: nested },
      { name: '30000 nested single-key maps then nil', bytes: nestedMap },
      { name: 'header only', bytes: bytesOf(head) },
      { name: 'empty input', bytes: new Uint8Array(0) },
      { name: '1 MiB + 1 bytes (expect refusal by size)', bytes: oversize },
    ];
  }
  throw new RangeError(`unknown crafted kind ${kind}`);
}

// ---------------------------------------------------------------------------------------------- self-test (Node only)

const entry = typeof process !== 'undefined' && process.argv?.[1];
const { pathToFileURL } = entry ? await import('node:url') : {};
if (entry && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFile } = await import('node:fs/promises');
  const { createDescriptorCodec } = await import('./wire-descriptor-codec.mjs');
  const { createMsgpackrCodec } = await import('./wire-msgpackr-codec.mjs');
  const { sliceSchema } = await import('./wire-slice-schema.mjs');
  const { Packr, Unpackr } = await import('msgpackr');
  // --corpus=FILE: a corpus written by wire-codec-selection.mjs --corpus-out (the same real messages).
  const option = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const corpus = JSON.parse(await readFile(option('corpus') ?? new URL('../../test-results/wire-1130-sample-corpus.json', import.meta.url), 'utf8'));
  const codecs = [
    [createDescriptorCodec(sliceSchema(corpus.lists)), 'descriptor'],
    [createMsgpackrCodec({ Packr, Unpackr }, { mode: 'inline' }), 'msgpackr'],
    [createMsgpackrCodec({ Packr, Unpackr }, { mode: 'provisioned', structures: corpus.structures }), 'msgpackr'],
  ];
  const base = corpus.views.contestant[0];
  const specimens = semanticSpecimens(base);
  const small = [{ type: 'ping', token: 'abc', rtt: 4.5 }, { type: 'input', seq: 3, x: 1, y: -1, attack: true, moveSlot: { from: 1, to: 2 } }];
  const summary = {};
  const t0 = performance.now();
  for (const [codec, kind] of codecs) {
    const semantics = checkSemantics(codec, specimens);
    const bad = semantics.filter(r => !r.ok), refused = semantics.filter(r => r.ok && r.outcome !== 'exact');
    const samples = [];
    for (const view of Object.values(corpus.views)) for (const m of view.slice(0, 2)) { try { samples.push(codec.encode(m)); } catch { /* not encodable by this codec */ } }
    for (const m of small) samples.push(codec.encode(m));
    const malformed = checkMalformed(codec, samples, { crafted: craftedInputs(kind) });
    summary[codec.name + (codec.name === 'msgpackr-provisioned' ? '' : '')] = {
      semantics: { specimens: semantics.length, exact: semantics.filter(r => r.outcome === 'exact').length,
        acceptedRefusals: refused.map(r => `${r.name} [${r.outcome}] ${r.detail}`),
        failures: bad.map(r => `${r.name} [${r.outcome}] ${r.detail}`) },
      malformed: { samples: samples.map(s => s.length), ...malformed },
    };
  }
  summary.seconds = +((performance.now() - t0) / 1000).toFixed(1);
  if (option('out')) {
    const { writeFile } = await import('node:fs/promises'), { createHash } = await import('node:crypto');
    const source = String(await readFile(new URL(import.meta.url))).replace(/\r\n/g, '\n');
    await writeFile(option('out'), JSON.stringify({ issue: 1130, date: new Date().toISOString(), node: process.version, corpus: option('corpus') ?? 'sample',
      safetySha256: createHash('sha256').update(source).digest('hex'), ...summary }, null, 1) + '\n');
  }
  console.log(JSON.stringify(summary, null, 1));
}
